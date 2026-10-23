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
  browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
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

test("student browser validates QR before face verification and does not require device registration", async () => {
  const page = await newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const section = { _id: "student-section-1", courseId: { _id: "course-1", code: "CS101", name: "Introduction to Computing" }, name: "A", academicYear: "2026-2027", room: { code: "B-204" } };
  const session = { sessionId: "student-session-e2e", courseCode: "CS101", section: "A", startedAt: new Date(Date.now() - 30000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const validationId = "3dc3af1a-9cc7-44d4-8cb2-7757f75d7e25";
  const handler = authHandler("Student", async (call) => {
    if (call.path === "/biometric/me" && call.method === "GET") return json({ data: { status: "ACTIVE" } });
    if (call.path === "/academic/sections" && call.method === "GET") return json({ data: [section] });
    if (call.path === "/attendance/records/me" && call.method === "GET") return json({ data: [] });
    if (call.path === "/attendance/sessions/available" && call.method === "GET") return json({ data: [session] });
    if (call.path === "/attendance/validate-qr" && call.method === "POST") return json({ data: { validationId, sessionId: session.sessionId, courseCode: "CS101", section: "A", expiresInMs: 180000 } });
    if (call.path === "/biometric/challenge-active" && call.method === "POST") return json({ error: { message: "Active biometric challenge expired or invalid" } }, 401);
    return json({ data: [] });
  });
  const calls = await mockApi(page, handler);
  await page.goto(base + "/login");
  await login(page, "Student");
  await page.waitForURL(/\/student\/dashboard$/);
  await page.getByRole("heading", { name: /Scan QR, verify your face, check in/i }).waitFor();
  await page.getByRole("heading", { name: "Available check-ins" }).waitFor();
  await page.getByRole("heading", { name: "Recent attendance" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Open camera and scan" }).isDisabled(), false);
  await page.getByRole("button", { name: "Open camera and scan" }).click();
  await page.locator(".student-qr-reader.is-active video").waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: "Stop camera" }).click();
  await page.locator(".student-qr-reader:not(.is-active)").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "Start face/liveness check" }).count(), 0);
  assert.equal(await page.getByText(/Device registration/i).count(), 0);
  assert.equal(calls.some((call) => call.path.startsWith("/devices/")), false);

  await page.getByText("Enter QR token manually (camera fallback)", { exact: true }).click();
  await page.getByLabel("QR token").fill("a-valid-server-issued-qr-token");
  await page.getByRole("button", { name: "Validate QR", exact: true }).click();
  await page.getByRole("button", { name: "Start face/liveness check" }).waitFor();
  await page.getByText(/QR verified by the server/i).waitFor();

  await page.getByRole("button", { name: "Start face/liveness check" }).click();
  await page.getByText(/Active biometric challenge expired or invalid/i).waitFor();
  assert.match(page.url(), /\/student\/dashboard$/);
  assert.equal(await page.getByRole("heading", { name: /Scan QR, verify your face, check in/i }).count(), 1);
  assert.ok(calls.some((call) => call.path === "/attendance/validate-qr" && call.method === "POST" && call.body.token === "a-valid-server-issued-qr-token"));
  assert.deepEqual(pageErrors, [], "Student attendance dashboard should not raise browser exceptions");
});

test("student face enrollment waits for lecturer approval instead of enabling check-in immediately", async () => {
  const page = await newPage({ viewport: { width: 390, height: 844 } });
  const calls = await mockApi(page, authHandler("Student", async (call) => {
    if (call.path === "/biometric/me" && call.method === "GET") return json({ data: null });
    if (call.path === "/academic/sections" && call.method === "GET") return json({ data: [] });
    if (call.path === "/attendance/records/me" && call.method === "GET") return json({ data: [] });
    if (call.path === "/attendance/sessions/available" && call.method === "GET") return json({ data: [] });
    if (call.path === "/attendance/validate-qr" && call.method === "POST") return json({ data: { validationId: "b5a7e0d8-c94e-4eeb-9d1e-7b63fe0e73f5", sessionId: "student-session-enroll", courseCode: "CS101", section: "A", expiresInMs: 180000 } });
    if (call.path === "/biometric/enroll" && call.method === "POST") return json({ data: { status: "PENDING_APPROVAL", enrolledAt: new Date().toISOString() } }, 201);
    return json({ data: [] });
  }));
  await page.goto(base + "/login");
  await login(page, "Student");
  await page.waitForURL(/\/student\/dashboard$/);
  await page.getByText("Enter QR token manually (camera fallback)", { exact: true }).click();
  await page.getByLabel("QR token").fill("a-valid-server-issued-qr-token");
  await page.getByRole("button", { name: "Validate QR", exact: true }).click();
  await page.getByRole("button", { name: "Open front camera" }).waitFor();
  await page.getByRole("button", { name: "Open front camera" }).click();
  await page.locator(".student-enrollment-camera video").waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    const video = document.querySelector(".student-enrollment-camera video");
    return Boolean(video && video.readyState >= 2 && video.videoWidth > 0);
  });
  await page.getByRole("button", { name: "Capture and enroll face" }).click();
  await page.getByText(/submitted for lecturer approval/i).waitFor();
  assert.equal(await page.getByRole("button", { name: "Start face/liveness check" }).count(), 0);
  assert.ok(calls.some((call) => call.path === "/biometric/enroll" && call.method === "POST"));
});

test("lecturer can review pending biometric enrollment requests through the protected approval screen", async () => {
  const page = await newPage();
  const calls = await mockApi(page, authHandler("Lecturer", async (call) => {
    if (call.path === "/biometric/enrollment-approvals" && call.method === "GET") return json({ data: [{ studentId: "student-review-1", name: "Test Student", rollNumber: "CS24B001", email: "student@example.test", enrolledAt: new Date().toISOString(), sections: [{ courseCode: "CS101", sectionName: "A" }] }] });
    if (call.path === "/biometric/enrollment-approvals/student-review-1/approve" && call.method === "POST") return json({ data: { status: "ACTIVE", studentId: "student-review-1" } });
    return json({ data: [] });
  }));
  await page.goto(base + "/login");
  await login(page, "Lecturer");
  await page.waitForURL(/\/lecturer\/dashboard$/);
  await page.getByRole("link", { name: "Face approvals", exact: true }).click();
  await page.waitForURL(/\/lecturer\/enrollment-approvals$/);
  await page.getByText("Test Student", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Approve enrollment" }).click();
  await page.getByText(/Face enrollment approved/i).waitFor();
  assert.ok(calls.some((call) => call.path === "/biometric/enrollment-approvals/student-review-1/approve" && call.method === "POST"));
});


test("student can submit face enrollment independently before an attendance QR exists", async () => {
  const page = await newPage({ viewport: { width: 390, height: 844 } });
  const calls = await mockApi(page, authHandler("Student", async (call) => {
    if (call.path === "/biometric/me" && call.method === "GET") return json({ data: null });
    if (call.path === "/biometric/enroll" && call.method === "POST") return json({ data: { status: "PENDING_APPROVAL", enrolledAt: new Date().toISOString() } }, 201);
    return json({ data: [] });
  }));
  await page.goto(base + "/login");
  await login(page, "Student");
  await page.waitForURL(/\/student\/dashboard$/);
  await page.getByRole("link", { name: "Face enrollment", exact: true }).click();
  await page.waitForURL(/\/student\/face-enrollment$/);
  await page.getByRole("heading", { name: "Face enrollment" }).waitFor();
  await page.getByRole("button", { name: "Open front camera" }).click();
  await page.locator(".student-enrollment-camera video").waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    const video = document.querySelector(".student-enrollment-camera video");
    return Boolean(video && video.readyState >= 2 && video.videoWidth > 0);
  });
  await page.getByRole("button", { name: "Capture and submit enrollment" }).click();
  await page.getByText(/submitted for lecturer approval/i).waitFor();
  assert.ok(calls.some((call) => call.path === "/biometric/enroll" && call.method === "POST"));
  assert.equal(calls.some((call) => call.path === "/attendance/validate-qr"), false, "enrollment must not require an attendance QR");
});
