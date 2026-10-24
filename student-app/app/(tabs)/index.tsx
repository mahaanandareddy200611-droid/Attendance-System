import { CameraView, useCameraPermissions } from "expo-camera";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
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
  const [livenessError, setLivenessError] = useState("");
  const [validationTicket, setValidationTicket] = useState<ValidationTicket | null>(null);
  const [activeChallenge, setActiveChallenge] = useState<Awaited<ReturnType<typeof issueActiveLivenessChallenge>> | null>(null);
  const [frameUris, setFrameUris] = useState<string[]>([]);
  const [assertionId, setAssertionId] = useState("");
  const [pendingAttempt, setPendingAttempt] = useState<PendingAttempt | null>(null);

  const showNotice = useCallback((message: string, kind: "info" | "success" | "error" = "info") => {
    setNotice(message);
    setNoticeKind(kind);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = setTimeout(() => setNotice(""), 7000);
    return () => clearTimeout(timeout);
  }, [notice]);

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
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.85, exif: false, base64: false });
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
    setLivenessError("");
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
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.85, exif: false, base64: false });
      if (!photo?.uri) throw new Error("The camera did not return a frame.");
      newUris = [...frameUris, photo.uri];
      setFrameUris(newUris);

      if (newUris.length < activeChallenge.steps.length) {
        showNotice("Frame " + newUris.length + " of " + activeChallenge.steps.length + " captured. Follow the next direction symbol.", "info");
        return;
      }

      showNotice("Checking the movement sequence and matching your face…", "info");
      const nextAssertion = await verifyActiveLiveness({
        token,
        sessionId,
        challengeId: activeChallenge.challengeId,
        challenge: activeChallenge.challenge,
        frames: newUris,
      });
      await deleteTemporaryPhotos(newUris);
      setCameraMode("none");
      setCameraReady(false);
      setAssertionId(nextAssertion);
      setActiveChallenge(null);
      setFrameUris([]);
      setLivenessError("");
      showNotice("Face match and liveness passed. Attendance is being recorded automatically.", "success");
    } catch (error) {
      await deleteTemporaryPhotos([...newUris, ...frameUris]);
      setFrameUris([]);
      setActiveChallenge(null);
      setAssertionId("");
      setLivenessError(getMessage(error));
      // Keep the front-camera modal and the server-validated QR ticket. The
      // next tap obtains a brand-new one-time challenge rather than reusing an
      // expired/consumed nonce or making the student scan the QR again.
      setCameraReady(true);
      setCameraMode("liveness");
      autoStartedTicketId.current = validationTicket.validationId;
      challengeStartedForTicket.current = validationTicket.validationId;
      scannerLock.current = true;
      showNotice(getMessage(error) + " Your QR validation is retained; start a fresh face check below.", "error");
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
      setLivenessError("");
      setFrameUris([]);
      setPendingAttempt(null);
      setCameraReady(false);
      // Keep the modal mounted and remount CameraView directly with the front
      // camera, avoiding a close/reopen flicker after the QR is accepted.
      setCameraMode("liveness");
      autoStartedTicketId.current = "";
      challengeStartedForTicket.current = "";
      showNotice("Live QR validated by the server. Follow the on-screen direction symbol in the front camera.", "success");
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
    setLivenessError("");
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
    setLivenessError("");
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

  const retryLivenessChallenge = useCallback(async () => {
    if (!token || !sessionId || !validationTicket || validationTicket.sessionId !== sessionId) {
      setLivenessError("The validated QR ticket is no longer available. Scan the lecturer's current QR again.");
      return;
    }
    if (busy || challengeRequestInFlight.current) return;

    void deleteTemporaryPhotos(frameUris);
    setFrameUris([]);
    setActiveChallenge(null);
    setAssertionId("");
    setLivenessError("");
    captureLock.current = false;
    automaticLivenessCapture.current = false;
    setLivenessCountdown(null);
    challengeStartedForTicket.current = validationTicket.validationId;
    challengeRequestInFlight.current = true;
    setBusy(true);

    try {
      const freshChallenge = await issueActiveLivenessChallenge(token, sessionId);
      setActiveChallenge(freshChallenge);
      showNotice("A fresh secure challenge is ready. Follow each arrow and hold the position until capture.", "info");
    } catch (error) {
      setActiveChallenge(null);
      setLivenessError(getMessage(error));
      showNotice(getMessage(error) + " If the QR ticket has expired, scan the lecturer's current QR again.", "error");
    } finally {
      challengeRequestInFlight.current = false;
      setBusy(false);
    }
  }, [token, sessionId, validationTicket, busy, frameUris, showNotice]);

  const closeCameraModal = useCallback(() => {
    if (busy) return;
    const closingMode = cameraMode;
    setCameraMode("none");
    setCameraReady(false);
    setEnrollmentCountdown(null);
    setLivenessCountdown(null);
    scannerLock.current = false;
    captureLock.current = false;
    automaticEnrollmentCapture.current = false;
    automaticLivenessCapture.current = false;

    if (closingMode === "liveness") {
      void deleteTemporaryPhotos(frameUris);
      setFrameUris([]);
      setActiveChallenge(null);
      setLivenessError("");
      challengeStartedForTicket.current = "";
      autoStartedTicketId.current = validationTicket?.validationId || "";
    } else if (closingMode === "scan") {
      setValidationTicket(null);
      setAssertionId("");
      setFrameUris([]);
      setActiveChallenge(null);
    }
  }, [busy, cameraMode, frameUris, validationTicket]);

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
        showNotice("Camera ready. Follow the large on-screen arrow; all five live frames will be captured automatically.", "info");
      })
      .catch((error) => {
        setActiveChallenge(null);
        setFrameUris([]);
        setAssertionId("");
        setLivenessError(getMessage(error));
        autoStartedTicketId.current = validationTicket.validationId;
        challengeStartedForTicket.current = validationTicket.validationId;
        scannerLock.current = true;
        // Stay in the front-camera modal so the student can request a new challenge.
        showNotice(getMessage(error) + " Your QR validation is retained; start a fresh face check below.", "error");
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
    setLivenessCountdown(4);
    let fired = false;
    const interval = setInterval(() => {
      setLivenessCountdown((remaining) => remaining !== null && Number.isFinite(remaining) && remaining > 1 ? remaining - 1 : 0);
    }, 1000);
    const timeout = setTimeout(() => {
      fired = true;
      automaticLivenessCapture.current = false;
      setLivenessCountdown(null);
      void captureLivenessFrame();
    }, 4100);

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
          <Text style={styles.subtitle}>Set up verification once, then scan your lecturer&apos;s live QR. Camera-based matching and liveness run automatically while the camera indicator stays visible.</Text>
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
          <Text style={styles.footer}>Your camera frames are sent for verification only. This screen does not upload them to retained-evidence storage.</Text>
        </ScrollView>
        {notice ? <View style={styles.toastContainer} pointerEvents="box-none"><Notice message={notice} kind={noticeKind} /></View> : null}
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

      </ScrollView>
      <Modal
        visible={cameraMode !== "none"}
        animationType="slide"
        statusBarTranslucent={Platform.OS === "android"}
        onRequestClose={closeCameraModal}
      >
        <View style={styles.cameraModalRoot}>
          <View style={styles.cameraModalHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.eyebrow}>
                {cameraMode === "enroll" ? "SECURE FACE SETUP" : cameraMode === "liveness" ? "LIVE FACE CHECK" : "ATTENDANCE QR"}
              </Text>
              <Text style={styles.cameraModalTitle}>
                {cameraMode === "enroll" ? "Enroll your face" : cameraMode === "liveness" ? "Follow the movement prompt" : "Scan the lecturer's QR"}
              </Text>
            </View>
            <Pressable style={styles.cameraCloseButton} disabled={busy} onPress={closeCameraModal}>
              <Text style={styles.cameraCloseButtonText}>Cancel</Text>
            </Pressable>
          </View>

          <View style={styles.cameraPreviewShell}>
            <CameraView
              key={cameraMode}
              ref={cameraRef}
              style={styles.cameraModalPreview}
              facing={cameraMode === "scan" ? "back" : "front"}
              mirror={false}
              onCameraReady={() => setCameraReady(true)}
              onMountError={(event) => {
                setCameraReady(false);
                showNotice(
                  event?.message
                    ? "Camera could not start: " + event.message + ". Check camera permission and close other apps using the camera."
                    : "Camera could not start. Check camera permission and close other apps using the camera.",
                  "error",
                );
              }}
              barcodeScannerSettings={cameraMode === "scan" ? { barcodeTypes: ["qr"] } : undefined}
              onBarcodeScanned={cameraMode === "scan" ? (result) => void onQrScanned(result.data) : undefined}
            />
            {cameraMode === "scan" ? (
              <View pointerEvents="none" style={styles.cameraGuideOverlay}>
                <View style={styles.qrGuideFrame} />
              </View>
            ) : (
              <View pointerEvents="none" style={styles.cameraGuideOverlay}>
                <View style={styles.faceGuideOval} />
              </View>
            )}
            {cameraMode === "liveness" && activeChallenge && activeStep ? (
              <View pointerEvents="none" style={styles.liveDirectionOverlay}>
                <Text style={styles.liveDirectionSymbol}>{livenessSymbol(activeStep.step)}</Text>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={styles.liveDirectionStep}>STEP {frameUris.length + 1} OF {activeChallenge.steps.length} · {directionLabel(activeStep.step)}</Text>
                  <Text style={styles.liveDirectionInstruction}>{activeStep.instruction}</Text>
                </View>
              </View>
            ) : null}
          </View>

          <View style={styles.cameraPromptPanel}>
            {cameraMode === "enroll" ? (
              <>
                <View style={styles.livenessPromptRow}>
                  <Text style={styles.directionSymbol}>◉</Text>
                  <View style={{ flex: 1, gap: 5 }}>
                    <Text style={styles.cameraModalTitle}>Keep your full face in the oval</Text>
                    <Text style={styles.muted}>Look straight ahead in good light. The app captures automatically; no capture button is needed.</Text>
                  </View>
                </View>
                <Text style={styles.cameraStatus}>{cameraReady ? "CAMERA ACTIVE · AUTOMATIC ENROLLMENT" : "STARTING CAMERA…"}</Text>
                {enrollmentCountdown !== null ? <Text style={styles.countdownText}>Capturing enrollment in {enrollmentCountdown}…</Text> : null}
                {busy || biometricBusy ? <Text style={styles.muted}>Submitting the enrollment image securely…</Text> : null}
              </>
            ) : cameraMode === "liveness" && activeChallenge && activeStep ? (
              <>
                <View style={styles.livenessPromptRow}>
                  <Text style={styles.directionSymbol}>{livenessSymbol(activeStep.step)}</Text>
                  <View style={{ flex: 1, gap: 5 }}>
                    <Text style={styles.eyebrow}>STEP {frameUris.length + 1} OF {activeChallenge.steps.length}</Text>
                    <Text style={styles.cameraModalTitle}>{activeStep.instruction}</Text>
                  </View>
                </View>
                <Text style={styles.muted}>Move as shown, keep both eyes and your full face visible, then hold the position until the countdown finishes.</Text>
                <Text style={styles.cameraStatus}>{cameraReady ? "CAMERA ACTIVE · MOVEMENT CHECK" : "STARTING CAMERA…"}</Text>
                {livenessCountdown !== null ? <Text style={styles.countdownText}>Capturing in {livenessCountdown}… hold the movement.</Text> : null}
                {busy ? <Text style={styles.muted}>Analyzing the captured frame…</Text> : null}
              </>
            ) : cameraMode === "liveness" ? (
              livenessError ? (
                <View style={{ gap: 10 }}>
                  <Text style={styles.cameraModalTitle}>Face check needs another attempt</Text>
                  <Text style={styles.warningText}>{livenessError}</Text>
                  <Text style={styles.muted}>Keep your face centered in good light. The same validated QR is retained while it remains valid.</Text>
                  <Pressable style={[styles.button, busy ? styles.buttonDisabled : null]} disabled={busy} onPress={() => void retryLivenessChallenge()}>
                    {busy ? <ActivityIndicator color="#07111f" /> : <Text style={styles.buttonText}>Start a fresh face check</Text>}
                  </Pressable>
                </View>
              ) : (
                <View style={styles.livenessPromptRow}>
                  <ActivityIndicator size="large" color="#63d7bf" />
                  <View style={{ flex: 1, gap: 5 }}>
                    <Text style={styles.cameraModalTitle}>Preparing your secure challenge…</Text>
                    <Text style={styles.muted}>Keep the face camera open. Your frames are processed for this check and temporary files are then deleted.</Text>
                  </View>
                </View>
              )
            ) : (
              <>
                <View style={styles.livenessPromptRow}>
                  <Text style={styles.directionSymbol}>▦</Text>
                  <View style={{ flex: 1, gap: 5 }}>
                    <Text style={styles.cameraModalTitle}>Scan the lecturer&apos;s current QR</Text>
                    <Text style={styles.muted}>Keep the code inside the square. When it is read, the app validates it and opens the front-camera check automatically.</Text>
                  </View>
                </View>
                <Text style={styles.cameraStatus}>{cameraReady ? "REAR CAMERA ACTIVE · QR SCANNER" : "STARTING CAMERA…"}</Text>
              </>
            )}
            {notice ? <Notice message={notice} kind={noticeKind} /> : null}
          </View>
        </View>
      </Modal>
      {notice ? <View style={styles.toastContainer} pointerEvents="box-none"><Notice message={notice} kind={noticeKind} /></View> : null}
    </View>
  );
}

function livenessSymbol(step?: string) {
  switch (step) {
    case "TURN_LEFT": return "←";
    case "TURN_RIGHT": return "→";
    case "MOVE_UP": return "↑";
    case "MOVE_DOWN": return "↓";
    default: return "◎";
  }
}

function directionLabel(step?: string) {
  switch (step) {
    case "TURN_LEFT": return "TURN LEFT";
    case "TURN_RIGHT": return "TURN RIGHT";
    case "MOVE_UP": return "MOVE UP";
    case "MOVE_DOWN": return "MOVE DOWN";
    default: return "FACE FORWARD";
  }
}

function Notice({ message, kind }: { message: string; kind: "info" | "success" | "error" }) {
  return (
    <View
      style={[styles.notice, kind === "success" ? styles.noticeSuccess : kind === "error" ? styles.noticeError : null]}
      accessibilityRole={kind === "error" ? "alert" : undefined}
      accessibilityLiveRegion={kind === "error" ? "assertive" : "polite"}
    >
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
  toastContainer: { position: "absolute", top: Platform.OS === "ios" ? 58 : 26, left: 16, right: 16, zIndex: 1000, elevation: 10 },
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
  cameraModalRoot: { flex: 1, backgroundColor: "#0b1220", paddingHorizontal: 18, paddingTop: Platform.OS === "ios" ? 58 : 28, paddingBottom: 20, gap: 14 },
  cameraModalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  cameraModalTitle: { color: "#e8eef7", fontSize: 19, lineHeight: 25, fontWeight: "800" },
  cameraCloseButton: { minHeight: 42, justifyContent: "center", paddingHorizontal: 13, borderRadius: 12, borderWidth: 1, borderColor: "#41516a", backgroundColor: "#151f2e" },
  cameraCloseButtonText: { color: "#d9e4f2", fontWeight: "800", fontSize: 13 },
  cameraPreviewShell: { position: "relative", width: "100%", height: 300, borderRadius: 20, overflow: "hidden", backgroundColor: "#050a12", borderWidth: 1, borderColor: "#33445a" },
  cameraModalPreview: { width: "100%", height: "100%" },
  cameraGuideOverlay: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, justifyContent: "center", alignItems: "center" },
  faceGuideOval: { width: 212, height: 240, borderWidth: 2, borderColor: "#70dfca", borderRadius: 140, backgroundColor: "rgba(11,18,32,0.03)" },
  liveDirectionOverlay: { position: "absolute", left: 10, right: 10, bottom: 10, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 16, backgroundColor: "rgba(5,10,18,0.94)", borderWidth: 1, borderColor: "#70dfca", zIndex: 5, elevation: 8 },
  liveDirectionSymbol: { width: 62, textAlign: "center", color: "#70dfca", fontSize: 54, lineHeight: 60, fontWeight: "900" },
  liveDirectionStep: { color: "#70dfca", fontSize: 10, lineHeight: 14, fontWeight: "900", letterSpacing: 0.7 },
  liveDirectionInstruction: { color: "#f3f7ff", fontSize: 13, lineHeight: 18, fontWeight: "700" },
  qrGuideFrame: { width: 234, height: 234, borderWidth: 3, borderColor: "#70dfca", borderRadius: 20, backgroundColor: "rgba(11,18,32,0.03)" },
  cameraPromptPanel: { backgroundColor: "#151f2e", borderRadius: 18, padding: 15, gap: 11, borderWidth: 1, borderColor: "rgba(154,173,198,0.16)", flexShrink: 1 },
  livenessPromptRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  directionSymbol: { width: 70, textAlign: "center", color: "#70dfca", fontSize: 56, lineHeight: 64, fontWeight: "900" },
});
