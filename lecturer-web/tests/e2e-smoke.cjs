"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { after, afterEach, before, test } = require("node:test");
const { chromium } = require("playwright");
const AxeBuilderModule = require("@axe-core/playwright");
const AxeBuilder = AxeBuilderModule.default || AxeBuilderModule;

const root = path.resolve(__dirname, "..");
const base = "http://127.0.0.1:4173";
let vite;
let browser;
const contexts = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  const viteEntry = path.join(root, "node_modules", "vite", "bin", "vite.js");
  assert.ok(existsSync(viteEntry), "Vite must be installed before browser tests run");
  vite = spawn(process.execPath, [viteEntry, "preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"], {
    cwd: root, stdio: "ignore", env: process.env,
  });
  let ready = false;
  for (let i = 0; i < 120; i += 1) {
    if (vite.exitCode !== null) throw new Error("Vite preview exited before startup: " + vite.exitCode);
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  assert.ok(ready, "Vite did not become ready in 30 seconds");
  browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
});

afterEach(async () => {
  await Promise.all([...contexts].map((ctx) => ctx.close().catch(() => {})));
  contexts.clear();
});

after(async () => {
  if (browser) await browser.close();
  if (vite && vite.exitCode === null) {
    vite.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => vite.once("exit", resolve)), sleep(3000)]);
    if (vite.exitCode === null) vite.kill("SIGKILL");
  }
});

async function newPage(options = {}) {
  const ctx = await browser.newContext({
    acceptDownloads: true,
    viewport: options.viewport || { width: 1280, height: 900 },
  });
  contexts.add(ctx);
  if (options.initScript) await ctx.addInitScript(options.initScript);
  return ctx.newPage();
}

function json(body, status = 200) { return { status, body }; }

async function mockApi(page, handler) {
  const calls = [];
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    let body = {};
    try { body = req.postDataJSON() || {}; } catch {}
    const call = {
      method: req.method(),
      path: url.pathname.replace(/^\/api\/v1/, "") || "/",
      params: url.searchParams,
      body,
      url: req.url(),
    };
    calls.push(call);
    const result = (await handler(call)) || json({ data: [] });
    await route.fulfill({
      status: result.status || 200,
      contentType: "application/json",
      body: JSON.stringify(result.body === undefined ? { data: [] } : result.body),
    });
  });
  return calls;
}

function authHandler(role, extra = () => undefined) {
  const user = {
    id: role.toLowerCase() + "-e2e",
    _id: role.toLowerCase() + "-e2e",
    role,
    name: role + " Test User",
    email: role.toLowerCase() + "@example.test",
  };
  return async (call) => {
    if (call.path === "/auth/login" && call.method === "POST") {
      if (call.body.email !== user.email || call.body.password !== "CorrectPassword123!") {
        return json({ error: { message: "Invalid email or password" } }, 401);
      }
      return json({ token: "browser-e2e-token", data: user });
    }
    if (call.path === "/auth/me" && call.method === "GET") return json({ data: user });
    if (call.path === "/auth/logout" && call.method === "POST") return json({ message: "Signed out" });
    return extra(call);
  };
}

async function login(page, role) {
  await page.getByLabel("Email").fill(role.toLowerCase() + "@example.test");
  await page.getByLabel("Password").fill("CorrectPassword123!");
  await page.getByRole("button", { name: "Login", exact: true }).click();
}

async function assertNoHorizontalOverflow(page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1),
    false,
    "The page should not overflow horizontally at this viewport",
  );
}

test("login rejects invalid credentials, supports keyboard focus, routes by role and signs out", async () => {
  const page = await newPage({ viewport: { width: 360, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const calls = await mockApi(page, authHandler("Lecturer"));
  await page.goto(base + "/login");
  assert.equal(await page.getByLabel("Email").getAttribute("type"), "email");
  await page.getByLabel("Email").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "login-password");
  await page.getByLabel("Email").fill("lecturer@example.test");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /invalid|login failed|password/i);
  await login(page, "Lecturer");
  await page.waitForURL(/\/lecturer\/dashboard$/);
  await page.getByRole("heading", { name: "Welcome, Lecturer" }).waitFor();
  const dashboardStyle = await page.locator(".academic-page").evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    paddingTop: getComputedStyle(element).paddingTop,
  }));
  assert.notEqual(dashboardStyle.background, "rgba(0, 0, 0, 0)",
    "The lecturer dashboard shared stylesheet must be loaded");

  assert.equal(await page.evaluate(() => sessionStorage.getItem("token")), "browser-e2e-token");
  await assertNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login$/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("token")), null);
  assert.ok(calls.some((c) => c.path === "/auth/login" && c.body.password === "wrong-password"));
  assert.ok(calls.some((c) => c.path === "/auth/logout" && c.method === "POST"));
  assert.deepEqual(pageErrors, [], "Auth screens should not raise browser exceptions");
});

test("student signup validates confirmation and submits the supported registration API", async () => {
  const page = await newPage();
  const calls = await mockApi(page, async (call) => {
    if (call.path === "/auth/signup" && call.method === "POST") {
      return json({ message: "Student account created" }, 201);
    }
    return json({ data: [] });
  });
  await page.goto(base + "/signup");
  await page.getByLabel("Name").fill("Sam Student");
  await page.getByLabel("Roll number").fill("24BCS101");
  await page.getByLabel("Email").fill("sam.student@example.test");
  await page.getByLabel("Mobile number").fill("9876543210");
  await page.getByLabel("Password", { exact: true }).fill("SecureStudent123!");
  await page.getByLabel("Confirm password").fill("DifferentPassword123!");
  await page.getByRole("button", { name: "Sign Up" }).click();
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /passwords do not match/i);
  assert.equal(calls.some((call) => call.path === "/auth/signup"), false);
  await page.getByLabel("Confirm password").fill("SecureStudent123!");
  await page.getByRole("button", { name: "Sign Up" }).click();
  await page.waitForURL(/\/login$/);
  assert.ok(calls.some((call) =>
    call.path === "/auth/signup" &&
    call.method === "POST" &&
    call.body.RollNumber === "24BCS101" &&
    call.body.faceImage_url === ""
  ));
  await page.getByText("Your student account is ready. Sign in to continue.").waitFor();
});

test("expired tokens are cleared and the role guard denies a lecturer route to an Admin", async () => {
  const expired = await newPage({ initScript: () => sessionStorage.setItem("token", "expired-token") });
  await mockApi(expired, async (call) => {
    if (call.path === "/auth/me") return json({ error: { message: "Session expired" } }, 401);
    return json({ data: [] });
  });
  await expired.goto(base + "/lecturer/attendance");
  await expired.waitForURL(/\/login$/);
  assert.equal(await expired.evaluate(() => sessionStorage.getItem("token")), null);

  const admin = await newPage();
  await mockApi(admin, authHandler("Admin"));
  await admin.goto(base + "/lecturer/attendance");
  await admin.waitForURL(/\/login$/);
  await login(admin, "Admin");
  await admin.waitForURL(/\/admin\/academic$/);
  await admin.getByRole("heading", { name: "Academic setup" }).waitFor();
});

test("password recovery checks OTP, blocks mismatched passwords and submits the reset token", async () => {
  const page = await newPage();
  const calls = await mockApi(page, async (call) => {
    if (call.path === "/auth/forget-password" && call.method === "POST") return json({ message: "Code request accepted" });
    if (call.path === "/auth/verify-reset-otp" && call.method === "POST") {
      if (call.body.otp !== "123456") return json({ error: { message: "Invalid code" } }, 400);
      return json({ resetToken: "A".repeat(43) });
    }
    if (call.path === "/auth/reset-password" && call.method === "POST") return json({ message: "Password reset" });
    return json({ data: [] });
  });
  await page.goto(base + "/forgot-password");
  await page.getByLabel("Email").fill("lecturer@example.test");
  await page.getByRole("button", { name: "Send one-time code" }).click();
  await page.getByRole("heading", { name: "Verify your email" }).waitFor();
  await page.getByLabel("One-time code").fill("123456");
  await page.getByRole("button", { name: "Verify code" }).click();
  await page.getByRole("heading", { name: "Choose a new password" }).waitFor();
  await page.getByLabel("New password", { exact: true }).fill("NewSecurePassword123!");
  await page.getByLabel("Confirm new password", { exact: true }).fill("DoesNotMatch123!");
  await page.getByRole("button", { name: "Reset password" }).click();
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /passwords do not match/i);
  assert.equal(calls.some((c) => c.path === "/auth/reset-password"), false);
  await page.getByLabel("Confirm new password", { exact: true }).fill("NewSecurePassword123!");
  await page.getByRole("button", { name: "Reset password" }).click();
  await page.waitForURL(/\/login$/);
  assert.ok(calls.some((c) => c.path === "/auth/verify-reset-otp" && c.body.otp === "123456"));
  assert.ok(calls.some((c) => c.path === "/auth/reset-password" && c.body.resetToken === "A".repeat(43)));
});



test("lecturer can recover a direct live-session URL and display its QR after a temporary list failure", async () => {
  const page = await newPage();
  const session = {
    sessionId: "direct-e2e-session",
    courseCode: "CS101",
    section: "A",
    status: "ACTIVE",
    startedAt: new Date(Date.now() - 30000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    eligibleStudentCount: 12,
  };
  const section = {
    _id: "direct-e2e-section",
    courseId: { _id: "course-e2e", code: "CS101", name: "Introduction to Computing" },
    name: "A",
    academicYear: "2026-2027",
  };
  let simulateDirectPageOutage = false;
  let directPageListRequests = 0;
  const calls = await mockApi(page, authHandler("Lecturer", async (call) => {
    if (call.path === "/academic/sections" && call.method === "GET") {
      return json({ data: [section] });
    }
    if (call.path === "/attendance/sessions" && call.method === "GET") {
      // Explicitly arm the failure only after the dashboard has loaded. Do not
      // rely on page.url() from inside a navigation-time API interception.
      if (simulateDirectPageOutage) {
        directPageListRequests += 1;
        if (directPageListRequests === 1) {
          return json({ error: { message: "Temporary session list outage" } }, 503);
        }
      }
      return json({ data: [session], pagination: { page: 1, limit: 100, total: 1, pages: 1 } });
    }
    if (call.path === "/attendance/sessions/direct-e2e-session/qr" && call.method === "GET") {
      return json({
        data: {
          sessionId: session.sessionId,
          token: "e2e-fresh-qr-token-1234567890",
          expiresAt: new Date(Date.now() + 3000).toISOString(),
          refreshMs: 5000,
        },
      });
    }
    return json({ data: [] });
  }));

  await page.goto(base + "/login");
  await login(page, "Lecturer");
  await page.waitForURL(/\/lecturer\/dashboard$/);
  // Let the dashboard finish its own requests, then force the first direct-route
  // sessions-list request to fail. The subsequent manual retry should recover.
  await page.waitForLoadState("networkidle");
  simulateDirectPageOutage = true;
  await page.goto(base + "/lecturer/sessions/direct-e2e-session/live");
  await page.getByRole("heading", { name: "Recover live attendance session" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Start attendance", exact: true }).count(), 0);

  await page.getByRole("button", { name: "Retry loading session", exact: true }).click();
  await page.getByRole("img", { name: "Server-issued rotating attendance QR code" }).waitFor();
  assert.ok(directPageListRequests >= 2, "the direct-page session list should be retried");
  assert.ok(calls.some((call) => call.path === "/attendance/sessions/direct-e2e-session/qr" && call.method === "GET"));
});

test("lecturer starts and ends a session, and a stale QR disappears after refresh fails", async () => {
  const page = await newPage();
  let session = null;
  let qrRequests = 0;
  const section = { _id: "section-1", courseId: { _id: "course-1", code: "CS101" }, name: "A", academicYear: "2026-2027" };
  const handler = authHandler("Lecturer", async (call) => {
    if (call.path === "/academic/sections" && call.method === "GET") return json({ data: [section] });
    if (call.path === "/attendance/sessions" && call.method === "GET") return json({ data: session ? [session] : [] });
    if (call.path === "/attendance/sessions" && call.method === "POST") {
      session = { sessionId: "session-e2e", courseCode: "CS101", section: "A", eligibleStudentCount: 1, expiresAt: new Date(Date.now() + 60000).toISOString() };
      qrRequests = 0;
      return json({ data: session });
    }
    if (call.path === "/attendance/sessions/session-e2e/qr" && call.method === "GET") {
      qrRequests += 1;
      if (qrRequests === 1) {
        return json({ data: { token: "e2e-challenge-token-1234567890", expiresAt: new Date(Date.now() + 10000).toISOString(), refreshMs: 500 } });
      }
      return json({ error: { message: "Temporary QR refresh failure" } }, 503);
    }
    if (call.path === "/attendance/sessions/session-e2e/end" && call.method === "POST") {
      session = null;
      return json({ message: "Session ended" });
    }
    return json({ data: [] });
  });
  const calls = await mockApi(page, handler);
  await page.goto(base + "/login");
  await login(page, "Lecturer");
  await page.waitForURL(/\/lecturer\/dashboard$/);
  await page.getByRole("link", { name: "Start attendance", exact: true }).click();
  await page.waitForURL(/\/lecturer\/sessions\/new$/);
  await page.getByLabel("Assigned section").selectOption("section-1");
  await page.getByRole("button", { name: "Start attendance", exact: true }).click();
  await page.waitForURL(/\/lecturer\/sessions\/session-e2e\/live$/);
  await page.getByRole("img", { name: "Server-issued rotating attendance QR code" }).waitFor();
  await page.getByText("QR refresh failed. Retrying…").waitFor({ timeout: 10000 });
  assert.equal(await page.getByRole("img", { name: "Server-issued rotating attendance QR code" }).count(), 0);
  assert.ok(qrRequests >= 2);
  page.on("dialog", async (dialog) => dialog.accept());
  await page.getByRole("button", { name: "End session" }).click();
  await page.getByText("Attendance session ended.").waitFor();
  await page.waitForURL(/\/lecturer\/sessions\/new$/);
  assert.ok(calls.some((c) => c.path === "/attendance/sessions" && c.method === "POST"));
  assert.ok(calls.some((c) => c.path === "/attendance/sessions/session-e2e/end" && c.method === "POST"));
  assert.equal(session, null);
});

test("reports filter and paginate records, and CSV export neutralizes formula injection", async () => {
  const page = await newPage({ viewport: { width: 360, height: 820 } });
  const maliciousName = '=HYPERLINK("https://evil.invalid")';
  const record = {
    _id: "attendance-1", courseCode: "CS101", section: "A",
    studentId: { Name: maliciousName, RollNumber: "R100", email: "student@example.test" },
    status: "Present", markedAt: "2026-10-21T08:30:00.000Z",
  };
  const handler = authHandler("Lecturer", async (call) => {
    if (call.path === "/attendance/records" && call.method === "GET") {
      const p = Number(call.params.get("page") || 1);
      return json({
        data: p === 1 ? [record] : [{ ...record, _id: "attendance-2", studentId: { Name: "Ada Student", RollNumber: "R101" } }],
        pagination: { page: p, pages: 2, total: 2 },
      });
    }
    return json({ data: [] });
  });
  const calls = await mockApi(page, handler);
  await page.goto(base + "/login");
  await login(page, "Lecturer");
  await page.waitForURL(/\/lecturer\/dashboard$/);
  await page.goto(base + "/lecturer/reports");
  await page.getByRole("heading", { name: "My section attendance" }).waitFor();
  await page.locator("tbody tr").first().waitFor();
  await assertNoHorizontalOverflow(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export current page" }).click(),
  ]);
  const csv = readFileSync(await download.path(), "utf8");
  assert.ok(csv.includes("'=HYPERLINK"), "CSV must neutralize formula-like values");
  await page.getByLabel("Student / roll number").fill("R100");
  const filteredRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname.endsWith("/attendance/records") &&
      url.searchParams.get("q") === "R100" &&
      url.searchParams.get("page") === "1";
  });
  await page.getByRole("button", { name: "Apply filters" }).click();
  await filteredRequest;
  await page.waitForFunction(() => document.body.innerText.includes("R100") && !document.body.innerText.includes("Loading attendance records…"));
  assert.ok(calls.some((c) => c.path === "/attendance/records" && c.params.get("q") === "R100" && c.params.get("page") === "1"));
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("Page 2 of 2") && !document.body.innerText.includes("Loading attendance records…"));
  assert.ok(calls.some((c) => c.path === "/attendance/records" && c.params.get("page") === "2" && c.params.get("q") === "R100"));
});

test("session results render server records, paginate and export the selected page", async () => {
  const page = await newPage({ viewport: { width: 390, height: 820 } });
  const first = {
    _id: "attendance-result-1",
    rollNumber: "R100",
    studentId: { Name: "Sam Student", email: "sam@example.test" },
    status: "Present",
    attendance: { markedAt: "2026-10-21T08:30:00.000Z" },
  };
  const second = {
    _id: "attendance-result-2",
    rollNumber: "R101",
    studentId: { Name: "Ada Student", email: "ada@example.test" },
    status: "Absent",
    attendance: { markedAt: null },
  };
  const calls = await mockApi(page, authHandler("Lecturer", async (call) => {
    if (call.path === "/attendance/sessions/session-results/records" && call.method === "GET") {
      const requestedPage = Number(call.params.get("page") || 1);
      return json({
        session: { sessionId: "session-results", courseCode: "CS101", section: "A" },
        data: requestedPage === 1 ? [first] : [second],
        pagination: { page: requestedPage, pages: 2, total: 2 },
      });
    }
    return json({ data: [] });
  }));
  await page.goto(base + "/login");
  await login(page, "Lecturer");
  await page.waitForURL(/\/lecturer\/dashboard$/);
  await page.goto(base + "/lecturer/sessions/session-results/attendance");
  await page.getByRole("heading", { name: "CS101 · Section A" }).waitFor();
  await page.getByText("R100").waitFor();
  await page.getByText("Present").waitFor();
  await assertNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("R101").waitFor();
  await page.getByText("Absent").waitFor();
  await page.getByText("Page 2 of 2").waitFor();
  assert.ok(calls.some((call) =>
    call.path === "/attendance/sessions/session-results/records" &&
    call.params.get("page") === "2"
  ));

  await page.getByLabel("Find a student").fill("R100");
  const filtered = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname.endsWith("/attendance/sessions/session-results/records") &&
      url.searchParams.get("q") === "R100" &&
      url.searchParams.get("page") === "1";
  });
  await filtered;
  await page.getByText("R100").waitFor();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export current page" }).click(),
  ]);
  const csv = readFileSync(await download.path(), "utf8");
  assert.ok(csv.includes("R100"));
});

test("administrator reports show institution data and send applied date/course filters", async () => {
  const page = await newPage();
  const calls = await mockApi(page, authHandler("Admin", async (call) => {
    if (call.path === "/attendance/records" && call.method === "GET") {
      return json({
        data: [{
          _id: "admin-report-1",
          courseCode: "CS101",
          section: "A",
          studentId: { Name: "Sam Student", RollNumber: "R100" },
          status: "Present",
          markedAt: "2026-10-21T08:30:00.000Z",
        }],
        pagination: { page: Number(call.params.get("page") || 1), pages: 1, total: 1 },
      });
    }
    return json({ data: [] });
  }));
  await page.goto(base + "/login");
  await login(page, "Admin");
  await page.waitForURL(/\/admin\/dashboard$/);
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await page.waitForURL(/\/admin\/reports$/);
  await page.getByRole("heading", { name: "Institution attendance" }).waitFor();
  await page.getByText("R100").waitFor();
  await page.getByLabel("From date").fill("2026-10-21");
  await page.getByLabel("Through date").fill("2026-10-22");
  await page.getByLabel("Course code").fill("CS101");
  const filtered = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname.endsWith("/attendance/records") &&
      url.searchParams.get("courseCode") === "CS101" &&
      url.searchParams.get("from") === "2026-10-21" &&
      url.searchParams.get("to") === "2026-10-22" &&
      url.searchParams.get("page") === "1";
  });
  await page.getByRole("button", { name: "Apply filters" }).click();
  await filtered;
  assert.ok(calls.some((call) =>
    call.path === "/attendance/records" &&
    call.method === "GET" &&
    call.params.get("courseCode") === "CS101" &&
    call.params.get("from") === "2026-10-21" &&
    call.params.get("to") === "2026-10-22" &&
    call.params.get("page") === "1"
  ));
});

test("login and admin dashboard pass automated axe accessibility checks", async () => {
  const page = await newPage();
  await mockApi(page, authHandler("Admin"));
  const scanCriticalAndSerious = async () => {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    return results.violations
      .filter((violation) => ["critical", "serious"].includes(violation.impact))
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.map((node) => ({ target: node.target, failureSummary: node.failureSummary })),
      }));
  };

  await page.goto(base + "/login");
  assert.deepEqual(await scanCriticalAndSerious(), [], "Login has no critical/serious axe violations");
  await login(page, "Admin");
  await page.waitForURL(/\/admin\/dashboard$/);
  await page.getByRole("heading", { name: "Academic overview" }).waitFor();
  assert.deepEqual(await scanCriticalAndSerious(), [], "Admin dashboard has no critical/serious axe violations");
});

test("Admin browser forms create a course, section, enrollment and Lecturer account", async () => {
  const page = await newPage();
  let courses = [{ _id: "course-1", code: "CS101", name: "Introduction to Computing", department: "CSE", semester: 1 }];
  let sections = [{ _id: "section-1", courseId: { _id: "course-1", code: "CS101" }, name: "A", academicYear: "2026-2027", semester: 1, roomCode: "B-204" }];
  let lecturers = [{ _id: "lecturer-1", Name: "Lara Lecturer", email: "lara@example.test" }];
  const students = [{ _id: "student-1", Name: "Sam Student", email: "sam@example.test", RollNumber: "R001" }];
  const handler = authHandler("Admin", async (call) => {
    if (call.path === "/academic/courses" && call.method === "GET") return json({ data: courses });
    if (call.path === "/academic/sections" && call.method === "GET") return json({ data: sections });
    if (call.path === "/academic/users" && call.method === "GET") return json({ data: call.params.get("role") === "Student" ? students : lecturers });
    if (call.path === "/academic/courses" && call.method === "POST") {
      const created = { _id: "course-2", ...call.body };
      courses = [...courses, created];
      return json({ data: { _id: created._id } });
    }
    if (call.path === "/academic/sections" && call.method === "POST") {
      const found = courses.find((course) => course._id === call.body.courseId);
      sections = [...sections, { _id: "section-2", ...call.body, courseId: found ? { _id: found._id, code: found.code } : null }];
      return json({ data: { _id: "section-2" } });
    }
    if (call.path === "/academic/enrollments" && call.method === "POST") return json({ data: { _id: "enrollment-e2e" } });
    if (call.path === "/auth/lecturers" && call.method === "POST") {
      lecturers = [...lecturers, { _id: "lecturer-2", Name: call.body.name, email: call.body.email }];
      return json({ message: "Lecturer account created.", data: { _id: "lecturer-2" } });
    }
    return json({ data: [] });
  });
  const calls = await mockApi(page, handler);
  await page.goto(base + "/login");
  await login(page, "Admin");
  await page.waitForURL(/\/admin\/dashboard$/);

  await page.getByRole("link", { name: "Courses", exact: true }).click();
  await page.getByLabel("Course code").fill("MA102");
  await page.getByLabel("Course name").fill("Discrete Mathematics");
  await page.getByLabel("Department").fill("CSE");
  await page.getByLabel("Semester").fill("2");
  await page.getByRole("button", { name: "Create course" }).click();
  await page.getByText(/Course creation completed/).waitFor();

  await page.getByRole("link", { name: "Sections", exact: true }).click();
  await page.waitForURL(/\/admin\/sections$/);
  await page.getByRole("heading", { name: "Class sections", exact: true }).waitFor();
  await page.getByRole("combobox").first().selectOption("course-1");
  await page.getByLabel("Section name").fill("B");
  await page.getByLabel("Academic year").fill("2026-2027");
  await page.getByLabel("Room code").fill("B-205");
  await page.getByLabel("Latitude").fill("13.0827");
  await page.getByLabel("Longitude").fill("80.2707");
  await page.getByLabel("Geofence radius (meters)").fill("100");
  await page.getByLabel("Assigned lecturer").selectOption("lecturer-1");
  await page.getByRole("button", { name: "Create section" }).click();
  await page.getByText(/Section creation completed/).waitFor();

  await page.getByRole("link", { name: "Enrollments", exact: true }).click();
  await page.getByRole("heading", { name: "Student enrollment", exact: true }).waitFor();
  await page.locator(".academic-enrollment-row label").filter({ hasText: "Student" }).locator("select").selectOption("student-1");
  await page.locator(".academic-enrollment-row label").filter({ hasText: "Section" }).locator("select").selectOption("section-1");
  await page.getByRole("button", { name: "Enroll student" }).click();
  await page.getByText(/Student enrollment completed/).waitFor();

  await page.getByRole("link", { name: "Lecturers", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("New Lecturer");
  await page.getByLabel("Email", { exact: true }).fill("newlecturer@example.test");
  await page.getByLabel("Mobile number").fill("9876543210");
  await page.getByLabel("Initial password").fill("TempPassword123!");
  await page.getByRole("button", { name: "Create Lecturer" }).click();
  await page.getByText("Lecturer account created.").waitFor();

  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/academic/courses" && c.body.code === "MA102"));
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/academic/sections" && c.body.lecturers.includes("lecturer-1")));
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/academic/enrollments" && c.body.studentId === "student-1" && c.body.sectionId === "section-1"));
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/auth/lecturers" && c.body.email === "newlecturer@example.test"));
});



test("student dashboard loads with QR-first setup and never calls device-registration APIs", async () => {
  const page = await newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const section = {
    _id: "student-section-1",
    courseId: { _id: "course-1", code: "CS101", name: "Introduction to Computing" },
    name: "A",
    academicYear: "2026-2027",
    room: { code: "B-204" },
  };
  const session = {
    sessionId: "student-session-e2e",
    courseCode: "CS101",
    section: "A",
    startedAt: new Date(Date.now() - 30000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const calls = await mockApi(page, authHandler("Student", async (call) => {
    if (call.path === "/biometric/me" && call.method === "GET") return json({ data: { status: "ACTIVE" } });
    if (call.path === "/academic/sections" && call.method === "GET") return json({ data: [section] });
    if (call.path === "/attendance/records/me" && call.method === "GET") return json({ data: [] });
    if (call.path === "/attendance/sessions/available" && call.method === "GET") return json({ data: [session] });
    return json({ data: [] });
  }));

  await page.goto(base + "/login");
  await login(page, "Student");
  await page.waitForURL(/\/student\/dashboard$/);
  await page.getByRole("heading", { name: "Check in to your class" }).waitFor();
  await page.getByRole("heading", { name: "One-time face enrollment" }).waitFor();
  await page.getByText("Face enrollment is active").waitFor();
  await page.getByText("CS101 · Section A", { exact: true }).first().waitFor();
  await page.getByText("Introduction to Computing").waitFor();
  await page.getByRole("heading", { name: "Available check-ins" }).waitFor();
  await page.getByRole("heading", { name: "Recent attendance" }).waitFor();
  await page.getByRole("button", { name: "Select session", exact: true }).click();
  await page.getByRole("heading", { name: "Scan and validate the lecturer QR" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Start face/liveness check" }).count(), 0,
    "Liveness must stay hidden until the server accepts a fresh QR");
  assert.equal(calls.some((call) => call.path.startsWith("/devices/")), false,
    "The student portal must not require or call device registration");
  await assertNoHorizontalOverflow(page);
  assert.deepEqual(pageErrors, [], "Student dashboard should not raise browser exceptions");
});

test("student can enroll their face once using the browser camera and stays signed in", async () => {
  const page = await newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const calls = await mockApi(page, authHandler("Student", async (call) => {
    if (call.path === "/biometric/me" && call.method === "GET") return json({ data: null });
    if (call.path === "/academic/sections" && call.method === "GET") return json({ data: [] });
    if (call.path === "/attendance/records/me" && call.method === "GET") return json({ data: [] });
    if (call.path === "/attendance/sessions/available" && call.method === "GET") return json({ data: [] });
    if (call.path === "/biometric/enroll" && call.method === "POST") {
      return json({ success: true, message: "Biometric enrollment completed", data: { status: "ACTIVE" } }, 201);
    }
    return json({ data: [] });
  }));

  await page.goto(base + "/login");
  await login(page, "Student");
  await page.waitForURL(/\/student\/dashboard$/);
  await page.getByRole("button", { name: "Use camera" }).click();
  const video = page.locator(".biometric-enrollment-video");
  await video.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const element = document.querySelector(".biometric-enrollment-video");
    return element && element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0;
  }, { timeout: 10000 });
  await page.getByRole("button", { name: "Capture face photo" }).click();
  await page.getByText(/face-enrollment\.jpg selected/i).waitFor();
  await page.getByRole("button", { name: "Save face enrollment" }).click();
  await page.getByText("Face enrollment is active").waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("token")), "browser-e2e-token",
    "Completing face enrollment must not log the student out");
  assert.ok(calls.some((call) => call.path === "/biometric/enroll" && call.method === "POST"));
  assert.equal(calls.some((call) => call.path.startsWith("/devices/")), false);
  assert.deepEqual(pageErrors, [], "Face enrollment should not raise browser exceptions");
});

test("student scans QR first, then completes active liveness and marks attendance", async () => {
  const page = await newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          success({ coords: { latitude: 15.4589, longitude: 75.0078, accuracy: 5 } });
        },
      },
    });
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const session = {
    sessionId: "student-session-e2e",
    courseCode: "CS101",
    section: "A",
    startedAt: new Date(Date.now() - 30000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const section = {
    _id: "student-section-1",
    courseId: { _id: "course-1", code: "CS101", name: "Introduction to Computing" },
    name: "A",
    academicYear: "2026-2027",
    room: { code: "B-204" },
  };
  const intentId = "b68a2f78-cb45-4c14-8315-fbe95d3ef681";
  const assertionId = "e21a6012-9782-4ff2-9707-332e3d53a10f";
  const activeChallengeId = "f5418db2-49d5-4689-a8fd-79ab87d6d6a1";
  let attendanceMarked = false;
  let validPreflightCount = 0;
  const calls = await mockApi(page, authHandler("Student", async (call) => {
    if (call.path === "/biometric/me" && call.method === "GET") return json({ data: { status: "NONE" } });
    if (call.path === "/academic/sections" && call.method === "GET") return json({ data: [section] });
    if (call.path === "/attendance/records/me" && call.method === "GET") {
      return json({ data: attendanceMarked ? [{
        _id: "attendance-e2e-1",
        courseCode: "CS101",
        section: "A",
        markedAt: new Date().toISOString(),
        verification: { qr: true, device: false, biometric: true, proximity: false },
      }] : [] });
    }
    if (call.path === "/attendance/sessions/available" && call.method === "GET") {
      return json({ data: attendanceMarked ? [] : [session] });
    }
    if (call.path === "/biometric/enroll" && call.method === "POST") {
      return json({ success: true, message: "Biometric enrollment completed", data: { status: "ACTIVE" } }, 201);
    }
    if (call.path === "/attendance/preflight" && call.method === "POST") {
      if (call.body.token.startsWith("invalid-")) return json({ error: { message: "This QR is invalid or expired" } }, 401);
      if (call.body.sessionId !== session.sessionId) return json({ error: { message: "QR belongs to a different session" } }, 409);
      validPreflightCount += 1;
      return json({
        success: true,
        message: "QR validated",
        data: {
          checkinIntentId: intentId,
          sessionId: session.sessionId,
          courseCode: session.courseCode,
          section: session.section,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          expiresInMs: 600000,
        },
      });
    }
    if (call.path === "/biometric/challenge-active" && call.method === "POST") {
      assert.equal(call.body.sessionId, session.sessionId);
      return json({
        success: true,
        data: {
          challengeId: activeChallengeId,
          challenge: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
          expiresInMs: 30000,
          steps: [
            { index: 0, step: "CENTER", instruction: "Face the camera straight on." },
            { index: 1, step: "TURN_LEFT", instruction: "Turn your face toward the left." },
            { index: 2, step: "TURN_RIGHT", instruction: "Turn your face toward the right." },
          ],
        },
      });
    }
    if (call.path === "/biometric/verify-active" && call.method === "POST") {
      return json({ success: true, data: {
        assertionId, verified: true, livenessPassed: true, faceMatchPassed: true,
        activeLivenessPassed: true, livenessMode: "ACTIVE_SEQUENCE_V1",
      } });
    }
    if (call.path === "/attendance/verify" && call.method === "POST") {
      attendanceMarked = true;
      return json({ success: true, message: "Attendance marked successfully", attendanceId: "attendance-e2e-1" }, 201);
    }
    return json({ data: [] });
  }));

  await page.goto(base + "/login");
  await login(page, "Student");
  await page.waitForURL(/\/student\/dashboard$/);
  await page.locator("#enrollment-image").setInputFiles({
    name: "consenting-test-face.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("synthetic-test-image-bytes"),
  });
  await page.getByRole("button", { name: "Save face enrollment" }).click();
  await page.getByText("Face enrollment is active").waitFor();

  await page.getByRole("button", { name: "Select session", exact: true }).click();
  await page.getByRole("heading", { name: "Scan and validate the lecturer QR" }).waitFor();
  await page.getByRole("button", { name: "Open camera and scan QR" }).click();
  await page.getByRole("button", { name: "Stop camera" }).waitFor({ timeout: 10000 });
  // Html5Qrcode owns its internal video/canvas visibility. Reaching the active
  // Stop camera state proves start() resolved; don't assert implementation details.
  await page.getByRole("button", { name: "Stop camera" }).click();

  await page.locator(".student-qr-fallback summary").click();
  await page.locator("#student-qr-token").fill("invalid-qr-token-long-enough-for-the-client");
  await page.getByRole("button", { name: "Validate QR" }).click();
  await page.getByRole("alert").filter({ hasText: /invalid|expired/i }).waitFor();
  assert.match(page.url(), /\/student\/dashboard$/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("token")), "browser-e2e-token",
    "A domain 401 from QR validation must not end a valid login");

  await page.locator("#student-qr-token").fill("server-signed-e2e-qr-token-1234567890");
  await page.getByRole("button", { name: "Validate QR" }).click();
  await page.getByRole("heading", { name: "Face match and liveness" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Start face/liveness check" }).count(), 1);
  assert.equal(calls.filter((call) => call.path === "/attendance/preflight").length, 2,
    "The invalid QR must be rejected and the valid QR checked");
  const preflightCall = calls.find((call) => call.path === "/attendance/preflight" && call.body.token.startsWith("server-signed-"));
  assert.ok(preflightCall, "The server must accept the QR before liveness begins");
  assert.equal(preflightCall.body.sessionId, session.sessionId);

  await page.getByRole("button", { name: "Start face/liveness check" }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector(".active-liveness-video");
    return video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  }, { timeout: 10000 });
  for (let step = 1; step <= 3; step += 1) {
    const captureButton = page.getByRole("button", { name: "Capture frame " + step + " of 3" });
    await captureButton.waitFor({ timeout: 10000 });
    await captureButton.click();
  }
  await page.getByText("Face match and liveness passed for this check-in.").waitFor();
  await page.getByRole("button", { name: "Get current location" }).click();
  await page.getByRole("button", { name: "Mark attendance" }).waitFor();
  await page.getByRole("button", { name: "Mark attendance" }).click();
  await page.getByText("Attendance marked successfully").waitFor();
  await page.getByRole("row").filter({ hasText: "CS101" }).last().waitFor();

  const preflightIndex = calls.findIndex((call) => call.path === "/attendance/preflight" && call.body.token.startsWith("server-signed-"));
  const challengeIndex = calls.findIndex((call) => call.path === "/biometric/challenge-active");
  const verifyIndex = calls.findIndex((call) => call.path === "/biometric/verify-active");
  const attendanceIndex = calls.findIndex((call) => call.path === "/attendance/verify");
  assert.ok(preflightIndex >= 0 && challengeIndex > preflightIndex && verifyIndex > challengeIndex && attendanceIndex > verifyIndex,
    "Expected sequence: valid QR preflight → active liveness challenge and verification → attendance submission");
  const attendanceCall = calls.find((call) => call.path === "/attendance/verify");
  assert.equal(attendanceCall.body.checkinIntentId, intentId);
  assert.equal(attendanceCall.body.biometricAssertionId, assertionId);
  assert.equal("deviceId" in attendanceCall.body, false);
  assert.equal("deviceSignature" in attendanceCall.body, false);
  assert.equal(calls.some((call) => call.path.startsWith("/devices/")), false,
    "Attendance must never require device-registration endpoints");
  assert.equal(validPreflightCount, 1);
  await assertNoHorizontalOverflow(page);
  assert.deepEqual(pageErrors, [], "Student check-in should not raise browser exceptions");
});
