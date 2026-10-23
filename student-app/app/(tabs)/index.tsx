import { CameraView, useCameraPermissions } from "expo-camera";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useStudentAuth } from "../../src/auth/AuthProvider";
import {
  getAvailableSessions,
  validateAttendanceQr,
  submitValidatedAttendance,
} from "../../src/lib/attendance";
import {
  deleteFaceEnrollment,
  enrollFace,
  getBiometricEnrollment,
  issueActiveLivenessChallenge,
  verifyActiveLiveness,
} from "../../src/lib/biometric";
import { deleteTemporaryPhotos } from "../../src/lib/photos";

type Session = {
  sessionId: string;
  courseCode?: string;
  section?: string;
  status?: string;
  startedAt?: string;
  expiresAt?: string;
};

type CameraMode = "none" | "enroll" | "liveness" | "scan";
type ValidationTicket = {
  validationId: string;
  sessionId: string;
  courseCode?: string;
  section?: string;
  expiresInMs?: number;
};
type PendingAttempt = {
  sessionId: string;
  validationId: string;
  idempotencyKey: string;
  biometricAssertionId: string;
};

function getMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "Something went wrong.");
  }
  return "Something went wrong. Please try again.";
}

function errorStatus(error: unknown) {
  return error && typeof error === "object" && "status" in error
    ? Number((error as { status?: unknown }).status)
    : 0;
}

function extractQrToken(value: string) {
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.token === "string") return parsed.token;
    if (parsed && typeof parsed.attendanceToken === "string") return parsed.attendanceToken;
  } catch {
    // The lecturer UI normally encodes the signed token directly in the QR.
  }
  if (!trimmed || trimmed.length > 8192) throw new Error("This QR does not contain a valid attendance token.");
  return trimmed;
}


export default function CheckInScreen() {
  const { user, token, loading: authLoading, login, logout } = useStudentAuth();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const scannerLock = useRef(false);
  const captureLock = useRef(false);
  const automaticEnrollmentCapture = useRef(false);
  const automaticLivenessCapture = useRef(false);
  const autoStartedTicketId = useRef("");
  const challengeStartedForTicket = useRef("");
  const challengeRequestInFlight = useRef(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>("none");
  const [notice, setNotice] = useState("");
  const [noticeKind, setNoticeKind] = useState<"info" | "success" | "error">("info");

  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [biometricStatus, setBiometricStatus] = useState("MISSING");
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [faceConsentAccepted, setFaceConsentAccepted] = useState(false);
  const [enrollmentCountdown, setEnrollmentCountdown] = useState<number | null>(null);
  const [livenessCountdown, setLivenessCountdown] = useState<number | null>(null);
  const [validationTicket, setValidationTicket] = useState<ValidationTicket | null>(null);
  const [activeChallenge, setActiveChallenge] = useState<Awaited<ReturnType<typeof issueActiveLivenessChallenge>> | null>(null);
  const [frameUris, setFrameUris] = useState<string[]>([]);
  const [assertionId, setAssertionId] = useState("");
  const [pendingAttempt, setPendingAttempt] = useState<PendingAttempt | null>(null);

  const showNotice = useCallback((message: string, kind: "info" | "success" | "error" = "info") => {
    setNotice(message);
    setNoticeKind(kind);
  }, []);

  const reloadData = useCallback(async () => {
    if (!token || !user) return;
    setLoading(true);
    try {
      const [sessionResult, biometricResult] = await Promise.allSettled([
        getAvailableSessions(token),
        getBiometricEnrollment(token),
      ]);
      if (sessionResult.status === "fulfilled") setSessions(sessionResult.value as Session[]);
      else showNotice(getMessage(sessionResult.reason), "error");
      if (biometricResult.status === "fulfilled") setBiometricStatus(biometricResult.value?.status || "MISSING");
      else showNotice(getMessage(biometricResult.reason), "error");
    } finally {
      setLoading(false);
    }
  }, [token, user, showNotice]);

  useEffect(() => {
    if (token && user) void reloadData();
    else {
      setSessions([]);
      setSessionId("");
      setBiometricStatus("MISSING");
      setFaceConsentAccepted(false);
      setValidationTicket(null);
      setActiveChallenge(null);
      setFrameUris([]);
      setAssertionId("");
      setPendingAttempt(null);
    }
  }, [token, user, reloadData]);

  const ensureCameraPermission = useCallback(async () => {
    if (cameraPermission?.granted) return true;
    const next = await requestCameraPermission();
    if (!next.granted) {
      showNotice("Camera permission is required for consented face enrollment, liveness and QR scanning.", "error");
      return false;
    }
    return true;
  }, [cameraPermission?.granted, requestCameraPermission, showNotice]);

  const openEnrollmentCamera = useCallback(async () => {
    if (!faceConsentAccepted) {
      showNotice("Read and accept the face-enrollment notice before enabling the camera.", "error");
      return;
    }
    if (!await ensureCameraPermission()) return;
    automaticEnrollmentCapture.current = false;
    setCameraReady(false);
    setCameraMode("enroll");
    showNotice("Face enrollment has started. Keep your face visible; the camera captures automatically after a short on-screen countdown.");
  }, [faceConsentAccepted, ensureCameraPermission, showNotice]);

  const captureEnrollment = useCallback(async () => {
    if (!cameraRef.current || !cameraReady || busy || !faceConsentAccepted || !token) {
      showNotice("Wait for the live camera preview and consent before capture.", "error");
      return;
    }
    setBusy(true);
    let imageUri = "";
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.82, exif: false, base64: false });
      if (!photo?.uri) throw new Error("The camera did not return an image.");
      imageUri = photo.uri;
      setCameraMode("none");
      setBiometricBusy(true);
      const response = await enrollFace(token, imageUri, faceConsentAccepted);
      const status = response.data?.status || "PENDING_APPROVAL";
      setBiometricStatus(status);
      setAssertionId("");
      if (status === "ACTIVE") {
        showNotice("Face enrollment is active. A live QR and face/liveness check are still required for every attendance check-in.", "success");
      } else {
        showNotice("Face enrollment submitted for lecturer approval. Attendance stays disabled until approval; do not submit another image while this request is pending.", "info");
      }
    } catch (error) {
      showNotice(getMessage(error), "error");
    } finally {
      if (imageUri) await deleteTemporaryPhotos([imageUri]);
      setBiometricBusy(false);
      setBusy(false);
    }
  }, [cameraReady, busy, faceConsentAccepted, token, showNotice]);

  useEffect(() => {
    if (
      cameraMode !== "enroll" ||
      !cameraReady ||
      !faceConsentAccepted ||
      busy ||
      biometricBusy ||
      automaticEnrollmentCapture.current
    ) return undefined;

    automaticEnrollmentCapture.current = true;
    setEnrollmentCountdown(2);
    let fired = false;
    const interval = setInterval(() => {
      setEnrollmentCountdown((remaining) => remaining !== null && Number.isFinite(remaining) && remaining > 1 ? remaining - 1 : 0);
    }, 1000);
    const timeout = setTimeout(() => {
      fired = true;
      automaticEnrollmentCapture.current = false;
      setEnrollmentCountdown(null);
      void captureEnrollment();
    }, 2100);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
      if (!fired) {
        automaticEnrollmentCapture.current = false;
        setEnrollmentCountdown(null);
      }
    };
  }, [cameraMode, cameraReady, faceConsentAccepted, busy, biometricBusy, captureEnrollment]);

  const removeFace = () => {
    Alert.alert(
      "Delete face enrollment?",
      "This removes the enrolled person and face samples from the configured biometric provider. If the provider is unavailable, deletion stays pending and attendance remains disabled.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            if (!token) return;
            setBiometricBusy(true);
            try {
              const response = await deleteFaceEnrollment(token);
              setBiometricStatus(response.data?.status || "REVOKED");
              setAssertionId("");
              showNotice("Biometric enrollment deletion completed.", "success");
            } catch (error) {
              setBiometricStatus("DELETE_PENDING");
              setAssertionId("");
              showNotice(
                errorStatus(error) === 503
                  ? "Provider deletion is pending. Attendance stays disabled while the backend retries deletion."
                  : getMessage(error),
                "error",
              );
            } finally {
              setBiometricBusy(false);
            }
          },
        },
      ],
    );
  };

  const startLiveness = useCallback(async () => {
    if (!token || !sessionId || !validationTicket) {
      showNotice("Scan and validate the selected class QR before face/liveness verification.", "error");
      return;
    }
    setFrameUris([]);
    setActiveChallenge(null);
    captureLock.current = false;
    automaticLivenessCapture.current = false;
    setLivenessCountdown(null);
    setCameraReady(false);
    setCameraMode("liveness");
    showNotice("QR accepted. Opening the front camera; the secure challenge starts after the live preview is ready.", "info");
  }, [token, sessionId, validationTicket, showNotice]);

  const captureLivenessFrame = useCallback(async () => {
    if (captureLock.current || busy) return;
    if (!cameraRef.current || !cameraReady || !activeChallenge || !token || !sessionId || !validationTicket) {
      showNotice("Wait for the visible camera preview and active QR ticket.", "error");
      return;
    }

    captureLock.current = true;
    setBusy(true);
    let newUris: string[] = [];
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.78, exif: false, base64: false });
      if (!photo?.uri) throw new Error("The camera did not return a frame.");
      newUris = [...frameUris, photo.uri];
      setFrameUris(newUris);

      if (newUris.length < 3) {
        const nextInstruction = activeChallenge.steps[newUris.length]?.instruction || "Keep your face visible";
        showNotice("Frame " + newUris.length + " of 3 received. Next prompt: " + nextInstruction + ". Capture continues automatically.", "info");
        return;
      }

      setCameraMode("none");
      setCameraReady(false);
      showNotice("Checking face identity and active liveness with the configured provider…", "info");
      const nextAssertion = await verifyActiveLiveness({
        token,
        sessionId,
        challengeId: activeChallenge.challengeId,
        challenge: activeChallenge.challenge,
        frames: newUris,
      });
      await deleteTemporaryPhotos(newUris);
      setAssertionId(nextAssertion);
      setActiveChallenge(null);
      setFrameUris([]);
      showNotice("Face match and liveness passed. Attendance is being recorded automatically.", "success");
    } catch (error) {
      await deleteTemporaryPhotos([...newUris, ...frameUris]);
      setFrameUris([]);
      setActiveChallenge(null);
      setAssertionId("");
      setCameraReady(false);
      setCameraMode("none");
      setValidationTicket(null);
      autoStartedTicketId.current = "";
      scannerLock.current = false;
      showNotice(getMessage(error) + " Scan a fresh QR and repeat the face check.", "error");
    } finally {
      captureLock.current = false;
      setBusy(false);
    }
  }, [busy, cameraReady, activeChallenge, token, sessionId, validationTicket, frameUris, showNotice]);

  const executeAttendanceAttempt = useCallback(async (attempt: PendingAttempt) => {
    if (!token) return;
    setBusy(true);
    try {
      const response = await submitValidatedAttendance({
        token,
        validationId: attempt.validationId,
        biometricAssertionId: attempt.biometricAssertionId,
        idempotencyKey: attempt.idempotencyKey,
      });
      setPendingAttempt(null);
      setAssertionId("");
      setValidationTicket(null);
      setFrameUris([]);
      setActiveChallenge(null);
      setCameraMode("none");
      scannerLock.current = false;
      autoStartedTicketId.current = "";
      challengeStartedForTicket.current = "";
      showNotice(response.message || "Attendance marked successfully.", "success");
      await reloadData();
    } catch (error) {
      const status = errorStatus(error);
      if (!status || status >= 500 || status === 429) {
        setPendingAttempt(attempt);
        showNotice("The server did not confirm the result. Retry the exact same attempt to recover its idempotent result. " + getMessage(error), "error");
      } else {
        setPendingAttempt(null);
        setAssertionId("");
        setValidationTicket(null);
        setCameraMode("none");
        scannerLock.current = false;
        autoStartedTicketId.current = "";
        challengeStartedForTicket.current = "";
        showNotice(getMessage(error) + " The QR ticket may have expired. Scan the current QR and repeat face verification.", "error");
      }
    } finally {
      setBusy(false);
    }
  }, [token, reloadData, showNotice]);

  const onQrScanned = async (value: string) => {
    if (scannerLock.current || busy || !sessionId || !token || biometricStatus !== "ACTIVE") return;
    scannerLock.current = true;
    try {
      const qrToken = extractQrToken(value);
      const ticket = await validateAttendanceQr(token, qrToken);
      if (ticket.sessionId !== sessionId) {
        throw new Error("This QR belongs to another class session. Select the correct session and scan its QR.");
      }
      setValidationTicket(ticket);
      setAssertionId("");
      setActiveChallenge(null);
      setFrameUris([]);
      setPendingAttempt(null);
      setCameraReady(false);
      setCameraMode("none");
      autoStartedTicketId.current = "";
      challengeStartedForTicket.current = "";
      showNotice("Live QR validated by the server. Face matching and liveness will now start automatically.", "success");
    } catch (error) {
      scannerLock.current = false;
      setCameraMode("none");
      showNotice(getMessage(error), "error");
    }
  };

  const openScanner = useCallback(async () => {
    if (!sessionId || !token) {
      showNotice("Select an active class session first.", "error");
      return;
    }
    if (biometricStatus !== "ACTIVE") {
      showNotice("Complete face enrollment and wait for lecturer approval before check-in.", "error");
      return;
    }
    if (!await ensureCameraPermission()) return;
    scannerLock.current = false;
    setValidationTicket(null);
    setAssertionId("");
    setActiveChallenge(null);
    setFrameUris([]);
    setPendingAttempt(null);
    autoStartedTicketId.current = "";
    challengeStartedForTicket.current = "";
    setCameraReady(false);
    setCameraMode("scan");
    showNotice("Scan the lecturer's current QR. After the server validates it, face matching and liveness run automatically.", "info");
  }, [sessionId, token, biometricStatus, ensureCameraPermission, showNotice]);

  const selectSession = (nextSessionId: string) => {
    void deleteTemporaryPhotos(frameUris);
    setSessionId(nextSessionId);
    setValidationTicket(null);
    setAssertionId("");
    setActiveChallenge(null);
    setFrameUris([]);
    setPendingAttempt(null);
    setCameraMode("none");
    setCameraReady(false);
    scannerLock.current = false;
    captureLock.current = false;
    automaticLivenessCapture.current = false;
    autoStartedTicketId.current = "";
    challengeStartedForTicket.current = "";
    showNotice("Class selected. Scan its live QR first; the app then runs the visible face/liveness check.", "info");
  };

  useEffect(() => {
    if (
      cameraMode !== "liveness" ||
      !cameraReady ||
      activeChallenge ||
      busy ||
      !validationTicket ||
      !token ||
      !sessionId ||
      challengeRequestInFlight.current ||
      challengeStartedForTicket.current === validationTicket.validationId
    ) return;

    challengeStartedForTicket.current = validationTicket.validationId;
    challengeRequestInFlight.current = true;
    setBusy(true);
    void issueActiveLivenessChallenge(token, sessionId)
      .then((challenge) => {
        setFrameUris([]);
        setActiveChallenge(challenge);
        showNotice("Camera ready. Follow each visible instruction; three live frames will be captured automatically.", "info");
      })
      .catch((error) => {
        setActiveChallenge(null);
        setFrameUris([]);
        setAssertionId("");
        setValidationTicket(null);
        autoStartedTicketId.current = "";
        challengeStartedForTicket.current = "";
        scannerLock.current = false;
        setCameraMode("none");
        setCameraReady(false);
        showNotice(getMessage(error) + " Scan the lecturer's current QR again.", "error");
      })
      .finally(() => {
        challengeRequestInFlight.current = false;
        setBusy(false);
      });
  }, [cameraMode, cameraReady, activeChallenge, busy, validationTicket, token, sessionId, showNotice]);

  useEffect(() => {
    if (
      !validationTicket ||
      !token ||
      !sessionId ||
      validationTicket.sessionId !== sessionId ||
      cameraMode !== "none" ||
      busy ||
      activeChallenge ||
      assertionId ||
      pendingAttempt ||
      autoStartedTicketId.current === validationTicket.validationId
    ) return;
    autoStartedTicketId.current = validationTicket.validationId;
    void startLiveness();
  }, [validationTicket, token, sessionId, cameraMode, busy, activeChallenge, assertionId, pendingAttempt, startLiveness]);

  useEffect(() => {
    const step = activeChallenge?.steps?.[frameUris.length];
    if (
      cameraMode !== "liveness" ||
      !cameraReady ||
      !activeChallenge ||
      !step ||
      busy ||
      automaticLivenessCapture.current
    ) return undefined;

    automaticLivenessCapture.current = true;
    setLivenessCountdown(2);
    let fired = false;
    const interval = setInterval(() => {
      setLivenessCountdown((remaining) => remaining !== null && Number.isFinite(remaining) && remaining > 1 ? remaining - 1 : 0);
    }, 1000);
    const timeout = setTimeout(() => {
      fired = true;
      automaticLivenessCapture.current = false;
      setLivenessCountdown(null);
      void captureLivenessFrame();
    }, 2100);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
      if (!fired) {
        automaticLivenessCapture.current = false;
        setLivenessCountdown(null);
      }
    };
  }, [cameraMode, cameraReady, activeChallenge, frameUris.length, busy, captureLivenessFrame]);

  useEffect(() => {
    if (!validationTicket || !assertionId || busy || pendingAttempt) return;
    const attempt: PendingAttempt = {
      sessionId: validationTicket.sessionId,
      validationId: validationTicket.validationId,
      idempotencyKey: Crypto.randomUUID(),
      biometricAssertionId: assertionId,
    };
    setPendingAttempt(attempt);
    void executeAttendanceAttempt(attempt);
  }, [validationTicket, assertionId, busy, pendingAttempt, executeAttendanceAttempt]);

  if (authLoading) {
    return <View style={styles.center}><ActivityIndicator size="large" color="#63d7bf" /><Text style={styles.muted}>Restoring secure student session…</Text></View>;
  }

  if (!user || !token) {
    return (
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.loginContent} keyboardShouldPersistTaps="handled">
          <View style={styles.brandMark}><Text style={styles.brandMarkText}>A</Text></View>
          <Text style={styles.eyebrow}>ATTENDANCE SYSTEM</Text>
          <Text style={styles.title}>Student check-in</Text>
          <Text style={styles.subtitle}>Sign in to register your phone, verify your face and mark attendance for an active class.</Text>
          <View style={styles.card}>
            <Text style={styles.label}>College email</Text>
            <TextInput
              style={styles.input}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
              placeholder="student@college.edu"
              placeholderTextColor="#8993a7"
            />
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              secureTextEntry
              autoComplete="password"
              value={password}
              onChangeText={setPassword}
              placeholder="Your password"
              placeholderTextColor="#8993a7"
            />
            <Pressable
              style={[styles.button, loginBusy && styles.buttonDisabled]}
              disabled={loginBusy || !email.trim() || !password}
              onPress={async () => {
                setLoginBusy(true);
                try {
                  await login(email, password);
                  setPassword("");
                  showNotice("Signed in. Complete device and face setup to continue.", "success");
                } catch (error) {
                  showNotice(getMessage(error), "error");
                } finally {
                  setLoginBusy(false);
                }
              }}
            >
              <Text style={styles.buttonText}>{loginBusy ? "Signing in…" : "Sign in"}</Text>
            </Pressable>
            <Text style={styles.footnote}>Use your existing college Student account. Admin and Lecturer accounts are rejected by this app.</Text>
          </View>
          {notice ? <Notice message={notice} kind={noticeKind} /> : null}
          <Text style={styles.footer}>Your camera frames are sent for verification only. This screen does not upload them to retained-evidence storage.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  const selectedSession = sessions.find((item) => item.sessionId === sessionId);
  const activeStep = activeChallenge?.steps?.[frameUris.length];

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>STUDENT WORKSPACE</Text>
            <Text style={styles.title}>Welcome{user.name ? ", " + user.name.split(" ")[0] : ""}</Text>
            <Text style={styles.subtitle}>{user.RollNumber || user.email}</Text>
          </View>
          <Pressable style={styles.outlineButton} onPress={() => void logout()}>
            <Text style={styles.outlineButtonText}>Log out</Text>
          </Pressable>
        </View>

        {notice ? <Notice message={notice} kind={noticeKind} /> : null}

        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <Text style={styles.cardTitle}>Setup checklist</Text>
            <Pressable disabled={loading} onPress={() => void reloadData()}>
              <Text style={styles.link}>{loading ? "Refreshing…" : "Refresh"}</Text>
            </Pressable>
          </View>
          <SetupRow
            title="Face enrollment"
            detail={biometricStatus === "ACTIVE"
              ? "Approved and active"
              : biometricStatus === "PENDING_APPROVAL"
                ? "Waiting for lecturer approval"
                : biometricStatus === "DELETE_PENDING"
                  ? "Deletion pending; check-in disabled"
                  : "Enrollment required"}
            ready={biometricStatus === "ACTIVE"}
          />
          {!["ACTIVE", "PENDING_APPROVAL", "DELETE_PENDING"].includes(biometricStatus) ? (
            <View style={styles.faceConsentPanel}>
              <Pressable
                style={styles.consentRow}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: faceConsentAccepted }}
                onPress={() => setFaceConsentAccepted((checked) => !checked)}
              >
                <View style={[styles.consentBox, faceConsentAccepted && styles.consentBoxChecked]}>
                  {faceConsentAccepted ? <Text style={styles.consentCheckmark}>✓</Text> : null}
                </View>
                <Text style={styles.consentText}>
                  I agree to face processing for attendance. After I start enrollment, the front camera preview remains visible and one live image is captured automatically. The provider creates the face profile used for matching; the attendance database stores a profile reference and consent metadata, not a raw face image or vector.
                </Text>
              </Pressable>
              <Pressable
                style={[styles.button, (!faceConsentAccepted || busy || biometricBusy) && styles.buttonDisabled]}
                disabled={!faceConsentAccepted || busy || biometricBusy}
                onPress={() => void openEnrollmentCamera()}
              >
                <Text style={styles.buttonText}>{biometricBusy ? "Submitting enrollment…" : "Start camera and enroll automatically"}</Text>
              </Pressable>
              <Text style={styles.footnote}>A lecturer or administrator must approve this enrollment before attendance is enabled.</Text>
            </View>
          ) : null}
          {biometricStatus === "PENDING_APPROVAL" ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>Your face enrollment is waiting for review. Do not submit it again; attendance stays disabled until an authorized lecturer or administrator approves it.</Text>
              <Pressable style={styles.secondaryButton} disabled={loading} onPress={() => void reloadData()}>
                <Text style={styles.secondaryButtonText}>Refresh approval status</Text>
              </Pressable>
            </View>
          ) : null}
          {biometricStatus === "ACTIVE" ? (
            <Pressable style={styles.secondaryButton} disabled={biometricBusy} onPress={removeFace}>
              <Text style={styles.secondaryButtonText}>{biometricBusy ? "Deleting…" : "Delete face enrollment"}</Text>
            </Pressable>
          ) : null}
          {biometricStatus === "DELETE_PENDING" ? (
            <Pressable style={styles.secondaryButton} disabled={loading} onPress={() => void reloadData()}>
              <Text style={styles.secondaryButtonText}>Refresh biometric deletion status</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <Text style={styles.cardTitle}>Active sessions</Text>
            <Text style={styles.pill}>{sessions.length + " available"}</Text>
          </View>
          {sessions.length === 0 ? (
            <Text style={styles.muted}>No active attendance session is available for your enrolled sections. Ask your lecturer to start one.</Text>
          ) : sessions.map((item) => (
            <Pressable
              key={item.sessionId}
              onPress={() => selectSession(item.sessionId)}
              style={[styles.sessionRow, sessionId === item.sessionId && styles.sessionRowSelected]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.sessionTitle}>{item.courseCode || "Course"} · Section {item.section || "—"}</Text>
                <Text style={styles.mutedSmall}>Expires {item.expiresAt ? new Date(item.expiresAt).toLocaleTimeString() : "as scheduled"}</Text>
                <Text style={styles.mutedSmall}>{item.sessionId.slice(0, 12)}</Text>
              </View>
              <Text style={sessionId === item.sessionId ? styles.selectedText : styles.link}>{sessionId === item.sessionId ? "Selected" : "Select"}</Text>
            </Pressable>
          ))}
        </View>

        {selectedSession && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Check in: {selectedSession.courseCode || "Course"} · {selectedSession.section || "Section"}</Text>
            <Text style={styles.subtitle}>Scan the lecturer&apos;s current QR first. Once the server validates it, the app automatically captures visible live-camera frames for face matching and liveness, then saves attendance.</Text>
            <Pressable
              style={[styles.button, (biometricStatus !== "ACTIVE" || busy || cameraMode !== "none") && styles.buttonDisabled]}
              disabled={biometricStatus !== "ACTIVE" || busy || cameraMode !== "none"}
              onPress={() => void openScanner()}
            >
              <Text style={styles.buttonText}>{busy ? "Processing check-in…" : "Scan QR and check in"}</Text>
            </Pressable>
            {validationTicket && !assertionId && !pendingAttempt ? (
              <Notice message="QR verified. Follow the live camera prompts; face and liveness frames are captured automatically." kind="info" />
            ) : null}
            {assertionId && validationTicket ? (
              <Text style={styles.successText}>Face match and liveness passed. Attendance is being saved automatically.</Text>
            ) : null}
            {validationTicket && !activeChallenge && !assertionId && !pendingAttempt && cameraMode === "none" && !busy ? (
              <Pressable
                style={styles.secondaryButton}
                onPress={() => {
                  autoStartedTicketId.current = validationTicket.validationId;
                  challengeStartedForTicket.current = "";
                  void startLiveness();
                }}
              >
                <Text style={styles.secondaryButtonText}>Retry face verification for this QR</Text>
              </Pressable>
            ) : null}
            {pendingAttempt ? (
              <View style={styles.warningBox}>
                <Text style={styles.warningText}>The server has not confirmed this attendance attempt. Retry with the same idempotency key so the result can be recovered safely.</Text>
                <Pressable style={styles.button} disabled={busy} onPress={() => void executeAttendanceAttempt(pendingAttempt)}>
                  <Text style={styles.buttonText}>{busy ? "Retrying…" : "Retry attendance safely"}</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        )}

        {cameraMode !== "none" && (
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <Text style={styles.cardTitle}>
                {cameraMode === "enroll" ? "Face enrollment" : cameraMode === "liveness" ? "Active liveness" : "Scan current QR"}
              </Text>
              <Pressable
                disabled={busy}
                onPress={() => {
                  setCameraMode("none");
                  setCameraReady(false);
                  scannerLock.current = false;
                  captureLock.current = false;
                  automaticLivenessCapture.current = false;
                  setEnrollmentCountdown(null);
                  setLivenessCountdown(null);
                  if (cameraMode === "liveness") {
                    void deleteTemporaryPhotos(frameUris);
                    setFrameUris([]);
                    setActiveChallenge(null);
                    challengeStartedForTicket.current = "";
                    automaticLivenessCapture.current = false;
                    setLivenessCountdown(null);
                  }
                }}
              >
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
            </View>
            <CameraView
              key={cameraMode}
              ref={cameraRef}
              style={styles.camera}
              facing={cameraMode === "scan" ? "back" : "front"}
              onCameraReady={() => setCameraReady(true)}
              barcodeScannerSettings={cameraMode === "scan" ? { barcodeTypes: ["qr"] } : undefined}
              onBarcodeScanned={cameraMode === "scan" ? (result) => void onQrScanned(result.data) : undefined}
            />
            {cameraMode === "enroll" ? (
              <View style={styles.cameraActions}>
                <Text style={styles.muted}>Keep your full face inside the live preview. The camera indicator remains visible while the image is captured and sent for enrollment.</Text>
                <Text style={styles.cameraStatus}>{cameraReady ? "CAMERA ACTIVE · AUTOMATIC CAPTURE" : "STARTING CAMERA…"}</Text>
                {enrollmentCountdown !== null ? <Text style={styles.countdownText}>Capturing enrollment in {enrollmentCountdown}… keep your face visible.</Text> : null}
                {busy || biometricBusy ? <Text style={styles.muted}>Submitting the enrollment image securely…</Text> : null}
              </View>
            ) : cameraMode === "liveness" && activeChallenge && activeStep ? (
              <View style={styles.cameraActions}>
                <Text style={styles.eyebrow}>STEP {frameUris.length + 1} OF 3</Text>
                <Text style={styles.cardTitle}>{activeStep.instruction}</Text>
                <Text style={styles.muted}>Follow the instruction and keep your full face visible. The live preview stays on, and the camera captures each frame automatically.</Text>
                <Text style={styles.cameraStatus}>CAMERA ACTIVE · LIVE MATCH + LIVENESS</Text>
                {livenessCountdown !== null ? <Text style={styles.countdownText}>Capturing frame {frameUris.length + 1} in {livenessCountdown}…</Text> : null}
                {busy ? <Text style={styles.muted}>Checking the captured frame…</Text> : null}
              </View>
            ) : cameraMode === "scan" ? (
              <View style={styles.cameraActions}>
                <Text style={styles.cardTitle}>Scan the lecturer&apos;s current QR</Text>
                <Text style={styles.muted}>Keep the code inside the frame. When decoded, the app signs and submits immediately—no extra confirmation tap consumes the QR freshness window.</Text>
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Notice({ message, kind }: { message: string; kind: "info" | "success" | "error" }) {
  return (
    <View style={[styles.notice, kind === "success" ? styles.noticeSuccess : kind === "error" ? styles.noticeError : null]}>
      <Text style={styles.noticeText}>{message}</Text>
    </View>
  );
}

function SetupRow({ title, detail, ready }: { title: string; detail: string; ready: boolean }) {
  return (
    <View style={styles.setupRow}>
      <View style={[styles.dot, ready ? styles.dotReady : null]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.setupTitle}>{title}</Text>
        <Text style={styles.mutedSmall}>{detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0b1220" },
  content: { padding: 18, paddingTop: 28, gap: 14, paddingBottom: 40 },
  loginContent: { flexGrow: 1, justifyContent: "center", padding: 22, gap: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: "#0b1220" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 2 },
  brandMark: { width: 54, height: 54, borderRadius: 18, backgroundColor: "#63d7bf", alignItems: "center", justifyContent: "center" },
  brandMarkText: { color: "#09211e", fontSize: 26, fontWeight: "800" },
  eyebrow: { fontSize: 11, fontWeight: "800", color: "#70dfca", letterSpacing: 1.5, marginBottom: 6 },
  title: { fontSize: 27, lineHeight: 33, fontWeight: "800", color: "#e8eef7" },
  subtitle: { fontSize: 14, lineHeight: 21, color: "#9aa9be", marginTop: 5, marginBottom: 10 },
  card: { backgroundColor: "#151f2e", borderRadius: 18, padding: 16, gap: 12, borderWidth: 1, borderColor: "rgba(154,173,198,0.16)" },
  cardTitle: { fontSize: 17, fontWeight: "800", color: "#e8eef7", marginBottom: 2 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  label: { color: "#c6d2e2", fontSize: 13, fontWeight: "700", marginBottom: -5 },
  input: { borderWidth: 1, borderColor: "#2e3d53", backgroundColor: "#0e1928", borderRadius: 12, minHeight: 48, paddingHorizontal: 13, color: "#e8eef7" },
  button: { backgroundColor: "#63d7bf", borderRadius: 12, minHeight: 47, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, paddingVertical: 12, marginTop: 3 },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: "#09211e", fontWeight: "800", fontSize: 14, textAlign: "center" },
  secondaryButton: { borderWidth: 1, borderColor: "#33445a", backgroundColor: "#111e2e", borderRadius: 12, minHeight: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: 12 },
  secondaryButtonText: { color: "#cbd6e5", fontWeight: "700", fontSize: 13 },
  outlineButton: { borderWidth: 1, borderColor: "#33445a", borderRadius: 10, paddingVertical: 9, paddingHorizontal: 11 },
  outlineButtonText: { color: "#cbd6e5", fontWeight: "700" },
  link: { color: "#70dfca", fontWeight: "800", fontSize: 13 },
  selectedText: { color: "#85e8d7", fontWeight: "800", fontSize: 13 },
  pill: { overflow: "hidden", borderRadius: 30, paddingHorizontal: 9, paddingVertical: 5, color: "#a9e9df", backgroundColor: "#173b41", fontSize: 11, fontWeight: "800" },
  sessionRow: { flexDirection: "row", gap: 10, alignItems: "center", padding: 12, borderRadius: 12, borderWidth: 1, borderColor: "rgba(154,173,198,0.16)", backgroundColor: "#101b2a" },
  sessionRowSelected: { borderColor: "#63d7bf", backgroundColor: "#17343a" },
  sessionTitle: { color: "#e8eef7", fontWeight: "800", fontSize: 14, marginBottom: 4 },
  setupRow: { flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 5 },
  setupTitle: { color: "#d9e4f2", fontSize: 13, fontWeight: "800", marginBottom: 3 },
  faceConsentPanel: { gap: 10, borderRadius: 14, padding: 12, backgroundColor: "#0e1928", borderWidth: 1, borderColor: "rgba(154,173,198,0.18)" },
  consentRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  consentBox: { width: 21, height: 21, borderRadius: 6, borderWidth: 1.5, borderColor: "#7588a4", backgroundColor: "#111e2e", alignItems: "center", justifyContent: "center", marginTop: 2 },
  consentBoxChecked: { borderColor: "#63d7bf", backgroundColor: "#173b41" },
  consentCheckmark: { color: "#90eddd", fontWeight: "900", fontSize: 14 },
  consentText: { flex: 1, color: "#bdcadb", fontSize: 12, lineHeight: 18 },
  cameraStatus: { color: "#148879", fontSize: 10, letterSpacing: 1.4, fontWeight: "900" },
  countdownText: { color: "#176d67", fontSize: 12, fontWeight: "800", lineHeight: 18 },
  dot: { width: 11, height: 11, borderRadius: 6, backgroundColor: "#cad1de" },
  dotReady: { backgroundColor: "#2ea36b" },
  muted: { color: "#9aa9be", fontSize: 13, lineHeight: 19 },
  mutedSmall: { color: "#8798b0", fontSize: 12, lineHeight: 17 },
  footnote: { color: "#8f9fb5", fontSize: 11, lineHeight: 16 },
  footer: { color: "#8798b0", fontSize: 11, lineHeight: 17, textAlign: "center", marginTop: 4 },
  notice: { borderRadius: 12, backgroundColor: "#1b2b40", padding: 12, borderWidth: 1, borderColor: "rgba(154,173,198,0.19)", gap: 9 },
  noticeSuccess: { backgroundColor: "#15352f", borderColor: "rgba(99,215,191,0.25)" },
  noticeError: { backgroundColor: "#3a2028", borderColor: "rgba(248,113,113,0.28)" },
  noticeText: { color: "#d8e3f1", fontSize: 12, lineHeight: 18, fontWeight: "600" },
  successText: { color: "#82e3cf", fontSize: 13, fontWeight: "800", lineHeight: 18 },
  warningBox: { borderRadius: 12, padding: 12, backgroundColor: "#352c20", borderWidth: 1, borderColor: "rgba(224,182,94,0.25)", gap: 10 },
  warningText: { color: "#f1d79d", fontSize: 12, lineHeight: 18 },
  dangerButton: { backgroundColor: "#852f3c", borderRadius: 12, minHeight: 43, alignItems: "center", justifyContent: "center" },
  camera: { width: "100%", height: 330, borderRadius: 14, overflow: "hidden", backgroundColor: "#101521" },
  cameraActions: { gap: 10, marginTop: 2 },
});
