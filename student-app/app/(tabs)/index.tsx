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
  captureLocationEvidence,
  getAvailableSessions,
  submitAttendance,
} from "../../src/lib/attendance";
import {
  deleteFaceEnrollment,
  enrollFace,
  getBiometricEnrollment,
  issueActiveLivenessChallenge,
  verifyActiveLiveness,
} from "../../src/lib/biometric";
import { apiRequest } from "../../src/lib/api";
import {
  getOrRegisterNativeDevice,
  getStoredNativeDeviceId,
  hasNativeDeviceKey,
  removeNativeDeviceKey,
} from "../../src/lib/device";
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
type LocationEvidence = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
};
type PendingAttempt = {
  sessionId: string;
  qrToken: string;
  idempotencyKey: string;
  biometricAssertionId: string;
  location: LocationEvidence;
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

function readTokenSessionId(token: string): string | null {
  try {
    const firstPart = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(firstPart), (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return typeof payload.sid === "string" ? payload.sid : null;
  } catch {
    return null;
  }
}

export default function CheckInScreen() {
  const { user, token, loading: authLoading, login, logout } = useStudentAuth();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const scannerLock = useRef(false);
  const captureLock = useRef(false);

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
  const [deviceId, setDeviceId] = useState("");
  const [deviceReady, setDeviceReady] = useState(false);
  const [deviceConflict, setDeviceConflict] = useState("");
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [biometricStatus, setBiometricStatus] = useState("MISSING");
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [locationEvidence, setLocationEvidence] = useState<LocationEvidence | null>(null);
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

      if (biometricResult.status === "fulfilled") {
        setBiometricStatus(biometricResult.value?.status || "MISSING");
      } else {
        showNotice(getMessage(biometricResult.reason), "error");
      }

      const localKeyExists = await hasNativeDeviceKey(user.id);
      const localId = await getStoredNativeDeviceId(user.id);
      try {
        const remote = await apiRequest<any>("/devices/me", { token });
        const credential = remote.data;
        if (
          localKeyExists &&
          localId &&
          credential?.status === "ACTIVE" &&
          credential?.deviceId === localId
        ) {
          setDeviceId(localId);
          setDeviceReady(true);
          setDeviceConflict("");
        } else if (credential?.status === "ACTIVE") {
          setDeviceId("");
          setDeviceReady(false);
          setDeviceConflict(String(credential.deviceId || "another registered device"));
        } else {
          setDeviceId("");
          setDeviceReady(false);
          setDeviceConflict("");
        }
      } catch (error) {
        showNotice("Could not check device registration: " + getMessage(error), "error");
      }
    } finally {
      setLoading(false);
    }
  }, [token, user, showNotice]);

  useEffect(() => {
    if (token && user) void reloadData();
    else {
      setSessions([]);
      setSessionId("");
      setDeviceReady(false);
      setDeviceId("");
      setBiometricStatus("MISSING");
    }
  }, [token, user, reloadData]);

  const ensureCameraPermission = async () => {
    if (cameraPermission?.granted) return true;
    const next = await requestCameraPermission();
    if (!next.granted) {
      showNotice("Camera permission is required for enrollment, liveness and QR scanning.", "error");
      return false;
    }
    return true;
  };

  const registerDevice = async (replaceExisting: boolean) => {
    if (!user || !token) return;
    setDeviceBusy(true);
    try {
      if (deviceConflict) {
        if (!replaceExisting) {
          showNotice("Another device is active. Confirm replacement only if you want this phone to become your registered device.", "error");
          return;
        }
        await apiRequest("/devices/me", { method: "DELETE", token });
        await removeNativeDeviceKey(user.id);
      }
      const nextId = await getOrRegisterNativeDevice(user.id, token);
      setDeviceId(nextId);
      setDeviceReady(true);
      setDeviceConflict("");
      showNotice("This phone is registered. Its signing seed stays in the phone's secure storage.", "success");
    } catch (error) {
      showNotice(getMessage(error), "error");
    } finally {
      setDeviceBusy(false);
    }
  };

  const openEnrollmentCamera = async () => {
    if (!await ensureCameraPermission()) return;
    setCameraReady(false);
    setCameraMode("enroll");
  };

  const captureEnrollment = async () => {
    if (!cameraRef.current || !cameraReady || busy) {
      showNotice("Wait for the camera preview to be ready.", "error");
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
      await enrollFace(token!, imageUri);
      setBiometricStatus("ACTIVE");
      setAssertionId("");
      showNotice("Face enrollment completed by the biometric provider.", "success");
    } catch (error) {
      showNotice(getMessage(error), "error");
    } finally {
      if (imageUri) await deleteTemporaryPhotos([imageUri]);
      setBiometricBusy(false);
      setBusy(false);
    }
  };

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

  const captureLocation = async () => {
    setBusy(true);
    try {
      const location = await captureLocationEvidence();
      setLocationEvidence(location);
      showNotice(
        "Location captured with approximately " + Math.round(location.accuracyMeters) + " m accuracy. Complete liveness, then scan the QR immediately.",
        "success",
      );
    } catch (error) {
      setLocationEvidence(null);
      showNotice(getMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const startLiveness = async () => {
    if (!token || !sessionId) {
      showNotice("Select an active attendance session first.", "error");
      return;
    }
    if (!deviceReady || biometricStatus !== "ACTIVE" || !locationEvidence) {
      showNotice("Register this phone, enroll your face and capture location before starting liveness.", "error");
      return;
    }
    if (!await ensureCameraPermission()) return;
    setBusy(true);
    try {
      const challenge = await issueActiveLivenessChallenge(token, sessionId);
      setActiveChallenge(challenge);
      setFrameUris([]);
      setAssertionId("");
      setPendingAttempt(null);
      setCameraReady(false);
      captureLock.current = false;
      setCameraMode("liveness");
      showNotice("Follow the server's randomized camera instructions. The challenge is short-lived.");
    } catch (error) {
      showNotice(getMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const captureLivenessFrame = async () => {
    if (captureLock.current || busy) return;
    if (!cameraRef.current || !cameraReady || !activeChallenge || !token || !sessionId) {
      showNotice("Wait for the camera preview to be ready.", "error");
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
        showNotice("Captured frame " + newUris.length + " of 3. Next: " + activeChallenge.steps[newUris.length].instruction);
        return;
      }

      setCameraMode("none");
      showNotice("Checking frame order, face identity and provider liveness…");
      const nextAssertion = await verifyActiveLiveness({
        token,
        sessionId,
        challengeId: activeChallenge.challengeId,
        challenge: activeChallenge.challenge,
        frames: newUris,
      });
      setAssertionId(nextAssertion);
      setActiveChallenge(null);
      setFrameUris([]);
      showNotice("Verification passed. The QR scanner is opening; scan the lecturer's current QR now.", "success");
      scannerLock.current = false;
      setCameraReady(false);
      setCameraMode("scan");
    } catch (error) {
      await deleteTemporaryPhotos(newUris);
      setFrameUris([]);
      setActiveChallenge(null);
      setAssertionId("");
      setCameraMode("none");
      showNotice(getMessage(error) + " Start a new liveness challenge before trying again.", "error");
    } finally {
      captureLock.current = false;
      setBusy(false);
    }
  };

  const executeAttendanceAttempt = async (attempt: PendingAttempt) => {
    if (!user || !token || !deviceId) return;
    setBusy(true);
    try {
      const response = await submitAttendance({
        userId: user.id,
        token,
        deviceId,
        sessionId: attempt.sessionId,
        qrToken: attempt.qrToken,
        idempotencyKey: attempt.idempotencyKey,
        biometricAssertionId: attempt.biometricAssertionId,
        location: attempt.location,
      });
      setPendingAttempt(null);
      setAssertionId("");
      setLocationEvidence(null);
      setFrameUris([]);
      setActiveChallenge(null);
      setCameraMode("none");
      scannerLock.current = false;
      showNotice(response.message || "Attendance marked successfully.", "success");
      await reloadData();
    } catch (error) {
      const status = errorStatus(error);
      if (!status || status >= 500 || status === 429) {
        setPendingAttempt(attempt);
        showNotice(
          "The server did not confirm the result. Retry the exact same attempt to recover its idempotent result. " + getMessage(error),
          "error",
        );
      } else {
        setPendingAttempt(null);
        setAssertionId("");
        setCameraMode("none");
        showNotice(getMessage(error) + " Capture a new liveness assertion and scan a fresh QR.", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const onQrScanned = async (value: string) => {
    if (scannerLock.current || busy || !sessionId || !assertionId || !locationEvidence || !token) return;
    scannerLock.current = true;
    try {
      const qrToken = extractQrToken(value);
      const tokenSessionId = readTokenSessionId(qrToken);
      if (tokenSessionId && tokenSessionId !== sessionId) {
        throw new Error("This QR belongs to another session. Keep the selected session and scan its QR.");
      }
      const attempt: PendingAttempt = {
        sessionId,
        qrToken,
        idempotencyKey: Crypto.randomUUID(),
        biometricAssertionId: assertionId,
        location: locationEvidence,
      };
      setPendingAttempt(attempt);
      setCameraMode("none");
      // Submit immediately from the barcode callback. Do not wait for another
      // button press after a 250 ms-class QR has been decoded.
      await executeAttendanceAttempt(attempt);
    } catch (error) {
      scannerLock.current = false;
      setCameraMode("none");
      showNotice(getMessage(error), "error");
    }
  };

  const openScanner = async () => {
    if (!assertionId || !locationEvidence || !deviceReady) {
      showNotice("Register the device, capture location and complete active liveness first.", "error");
      return;
    }
    if (!await ensureCameraPermission()) return;
    scannerLock.current = false;
    setCameraReady(false);
    setCameraMode("scan");
    showNotice("Point the back camera at the selected session's current QR. Attendance submits immediately after decode.");
  };

  const selectSession = (nextSessionId: string) => {
    setSessionId(nextSessionId);
    setAssertionId("");
    setActiveChallenge(null);
    setFrameUris([]);
    setLocationEvidence(null);
    setPendingAttempt(null);
    setCameraMode("none");
    scannerLock.current = false;
    showNotice("Session selected. Capture location, finish liveness and then scan its fresh QR.");
  };

  if (authLoading) {
    return <View style={styles.center}><ActivityIndicator size="large" color="#3157d5" /><Text style={styles.muted}>Restoring secure student session…</Text></View>;
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
          <SetupRow title="Phone device key" detail={deviceReady ? "Registered and active" : deviceConflict ? "Another device is registered" : "Not registered"} ready={deviceReady} />
          <SetupRow title="Face enrollment" detail={biometricStatus === "ACTIVE" ? "Enrolled" : biometricStatus === "DELETE_PENDING" ? "Deletion pending; check-in disabled" : "Not enrolled"} ready={biometricStatus === "ACTIVE"} />
          <SetupRow title="Location" detail={locationEvidence ? "Accuracy approximately " + Math.round(locationEvidence.accuracyMeters) + " m" : "Capture before the QR scan"} ready={Boolean(locationEvidence)} />
          {!deviceReady && (
            <Pressable style={[styles.button, deviceBusy && styles.buttonDisabled]} disabled={deviceBusy} onPress={() => void registerDevice(false)}>
              <Text style={styles.buttonText}>{deviceBusy ? "Registering…" : deviceConflict ? "Replace registered device…" : "Register this phone"}</Text>
            </Pressable>
          )}
          {deviceConflict ? (
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>Registered device: {deviceConflict}. Replacing it revokes the currently active device so only this phone can submit attendance.</Text>
              <Pressable style={styles.dangerButton} disabled={deviceBusy} onPress={() => void registerDevice(true)}>
                <Text style={styles.buttonText}>{deviceBusy ? "Replacing…" : "Confirm replacement"}</Text>
              </Pressable>
            </View>
          ) : null}
          {biometricStatus !== "ACTIVE" && biometricStatus !== "DELETE_PENDING" ? (
            <Pressable style={styles.button} disabled={busy || biometricBusy} onPress={() => void openEnrollmentCamera()}>
              <Text style={styles.buttonText}>{biometricBusy ? "Enrolling…" : "Capture face enrollment"}</Text>
            </Pressable>
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
            <Text style={styles.subtitle}>Prepare location first. Complete the server&apos;s randomized center/left/right camera sequence. Once it passes, the QR scanner opens and submits automatically after reading the selected session&apos;s fresh QR.</Text>
            <Pressable
              style={styles.secondaryButton}
              disabled={busy}
              onPress={() => void captureLocation()}
            >
              <Text style={styles.secondaryButtonText}>{busy && !locationEvidence ? "Getting location…" : locationEvidence ? "Refresh location" : "Get current location"}</Text>
            </Pressable>
            {locationEvidence ? (
              <Text style={styles.footnote}>Captured {new Date(locationEvidence.capturedAt).toLocaleTimeString()} · accuracy ±{Math.round(locationEvidence.accuracyMeters)} m</Text>
            ) : null}
            <Pressable
              style={[styles.button, (!deviceReady || biometricStatus !== "ACTIVE" || !locationEvidence || busy) && styles.buttonDisabled]}
              disabled={!deviceReady || biometricStatus !== "ACTIVE" || !locationEvidence || busy}
              onPress={() => void startLiveness()}
            >
              <Text style={styles.buttonText}>{busy ? "Please wait…" : "Start face & liveness check"}</Text>
            </Pressable>
            {assertionId && cameraMode === "none" ? (
              <Text style={styles.successText}>Liveness passed. Scan the current QR to submit attendance.</Text>
            ) : null}
            {pendingAttempt ? (
              <View style={styles.warningBox}>
                <Text style={styles.warningText}>The last request may have committed even though the response was lost. Retry the same idempotency key to recover its result.</Text>
                <Pressable style={styles.button} disabled={busy} onPress={() => void executeAttendanceAttempt(pendingAttempt)}>
                  <Text style={styles.buttonText}>{busy ? "Retrying…" : "Retry previous attempt safely"}</Text>
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
                onPress={() => {
                  setCameraMode("none");
                  setCameraReady(false);
                  scannerLock.current = false;
                  captureLock.current = false;
                  if (cameraMode === "liveness") {
                    void deleteTemporaryPhotos(frameUris);
                    setFrameUris([]);
                    setActiveChallenge(null);
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
                <Text style={styles.muted}>Face the camera straight on in good light. The photo is submitted to the provider for enrollment and removed from the temporary cache afterwards.</Text>
                <Pressable style={styles.button} disabled={!cameraReady || busy} onPress={() => void captureEnrollment()}>
                  <Text style={styles.buttonText}>{busy || biometricBusy ? "Working…" : "Capture and enroll face"}</Text>
                </Pressable>
              </View>
            ) : cameraMode === "liveness" && activeChallenge && activeStep ? (
              <View style={styles.cameraActions}>
                <Text style={styles.eyebrow}>STEP {frameUris.length + 1} OF 3</Text>
                <Text style={styles.cardTitle}>{activeStep.instruction}</Text>
                <Text style={styles.muted}>Follow the instruction and keep your face visible. The server checks frame order and provider liveness signals. A failed challenge must be restarted.</Text>
                <Pressable style={styles.button} disabled={!cameraReady || busy} onPress={() => void captureLivenessFrame()}>
                  <Text style={styles.buttonText}>{busy ? "Checking…" : "Capture frame " + (frameUris.length + 1)}</Text>
                </Pressable>
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
  screen: { flex: 1, backgroundColor: "#f3f5fa" },
  content: { padding: 18, paddingTop: 28, gap: 14, paddingBottom: 40 },
  loginContent: { flexGrow: 1, justifyContent: "center", padding: 22, gap: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: "#f3f5fa" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 2 },
  brandMark: { width: 54, height: 54, borderRadius: 18, backgroundColor: "#3157d5", alignItems: "center", justifyContent: "center" },
  brandMarkText: { color: "#ffffff", fontSize: 26, fontWeight: "800" },
  eyebrow: { fontSize: 11, fontWeight: "800", color: "#5265a6", letterSpacing: 1.5, marginBottom: 6 },
  title: { fontSize: 27, lineHeight: 33, fontWeight: "800", color: "#17223b" },
  subtitle: { fontSize: 14, lineHeight: 21, color: "#65708a", marginTop: 5, marginBottom: 10 },
  card: { backgroundColor: "#ffffff", borderRadius: 18, padding: 16, gap: 12, borderWidth: 1, borderColor: "#e1e6f0" },
  cardTitle: { fontSize: 17, fontWeight: "800", color: "#1c2942", marginBottom: 2 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  label: { color: "#34415e", fontSize: 13, fontWeight: "700", marginBottom: -5 },
  input: { borderWidth: 1, borderColor: "#dce2ee", backgroundColor: "#f9faff", borderRadius: 12, minHeight: 48, paddingHorizontal: 13, color: "#17223b" },
  button: { backgroundColor: "#3157d5", borderRadius: 12, minHeight: 47, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, paddingVertical: 12, marginTop: 3 },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: "#ffffff", fontWeight: "800", fontSize: 14, textAlign: "center" },
  secondaryButton: { borderWidth: 1, borderColor: "#cbd5e8", backgroundColor: "#f7f9ff", borderRadius: 12, minHeight: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: 12 },
  secondaryButtonText: { color: "#2e456f", fontWeight: "700", fontSize: 13 },
  outlineButton: { borderWidth: 1, borderColor: "#cbd5e8", borderRadius: 10, paddingVertical: 9, paddingHorizontal: 11 },
  outlineButtonText: { color: "#334466", fontWeight: "700" },
  link: { color: "#3157d5", fontWeight: "800", fontSize: 13 },
  selectedText: { color: "#2d7d58", fontWeight: "800", fontSize: 13 },
  pill: { overflow: "hidden", borderRadius: 30, paddingHorizontal: 9, paddingVertical: 5, color: "#39558f", backgroundColor: "#eff3ff", fontSize: 11, fontWeight: "800" },
  sessionRow: { flexDirection: "row", gap: 10, alignItems: "center", padding: 12, borderRadius: 12, borderWidth: 1, borderColor: "#e2e7f1" },
  sessionRowSelected: { borderColor: "#6480e5", backgroundColor: "#f3f6ff" },
  sessionTitle: { color: "#1c2942", fontWeight: "800", fontSize: 14, marginBottom: 4 },
  setupRow: { flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 5 },
  setupTitle: { color: "#253250", fontSize: 13, fontWeight: "800", marginBottom: 3 },
  dot: { width: 11, height: 11, borderRadius: 6, backgroundColor: "#cad1de" },
  dotReady: { backgroundColor: "#2ea36b" },
  muted: { color: "#6f7a91", fontSize: 13, lineHeight: 19 },
  mutedSmall: { color: "#7a859b", fontSize: 12, lineHeight: 17 },
  footnote: { color: "#77839a", fontSize: 11, lineHeight: 16 },
  footer: { color: "#7a859b", fontSize: 11, lineHeight: 17, textAlign: "center", marginTop: 4 },
  notice: { borderRadius: 12, backgroundColor: "#e8efff", padding: 12, borderWidth: 1, borderColor: "#d5e1ff" },
  noticeSuccess: { backgroundColor: "#e6f7ef", borderColor: "#c4ecd9" },
  noticeError: { backgroundColor: "#fff0ee", borderColor: "#ffd8d2" },
  noticeText: { color: "#33415f", fontSize: 12, lineHeight: 18, fontWeight: "600" },
  successText: { color: "#28754e", fontSize: 13, fontWeight: "800", lineHeight: 18 },
  warningBox: { borderRadius: 12, padding: 12, backgroundColor: "#fff7e8", borderWidth: 1, borderColor: "#f2dfb9", gap: 10 },
  warningText: { color: "#79541a", fontSize: 12, lineHeight: 18 },
  dangerButton: { backgroundColor: "#a93d35", borderRadius: 12, minHeight: 43, alignItems: "center", justifyContent: "center" },
  camera: { width: "100%", height: 330, borderRadius: 14, overflow: "hidden", backgroundColor: "#101521" },
  cameraActions: { gap: 10, marginTop: 2 },
});
