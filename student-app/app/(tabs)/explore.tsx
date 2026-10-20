import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useStudentAuth } from "../../src/auth/AuthProvider";
import { apiRequest } from "../../src/lib/api";

type RecordItem = {
  _id?: string;
  courseCode?: string;
  section?: string;
  markedAt?: string;
  verification?: {
    qr?: boolean;
    device?: boolean;
    biometric?: boolean;
  };
  sessionId?: {
    sessionId?: string;
    courseCode?: string;
    section?: string;
    startedAt?: string;
    status?: string;
  } | string;
};

function errorMessage(error: unknown) {
  return error && typeof error === "object" && "message" in error
    ? String((error as { message?: unknown }).message || "Could not load attendance.")
    : "Could not load attendance.";
}

export default function AttendanceHistoryScreen() {
  const { user, token } = useStudentAuth();
  const [items, setItems] = useState<RecordItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!token || !user) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await apiRequest<RecordItem[]>("/attendance/records/me?limit=50", { token });
      setItems(Array.isArray(response.data) ? response.data : []);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [token, user]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>STUDENT WORKSPACE</Text>
            <Text style={styles.title}>Attendance history</Text>
            <Text style={styles.subtitle}>The server's saved attendance records are authoritative.</Text>
          </View>
          <Pressable style={styles.refreshButton} disabled={loading} onPress={() => void reload()}>
            <Text style={styles.refreshText}>{loading ? "Loading…" : "Refresh"}</Text>
          </Pressable>
        </View>

        {!user ? (
          <View style={styles.card}>
            <Text style={styles.bodyText}>Sign in from the Check in tab to view your attendance history.</Text>
          </View>
        ) : loading && items.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#3157d5" />
            <Text style={styles.muted}>Loading attendance records…</Text>
          </View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable style={styles.retryButton} onPress={() => void reload()}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>No attendance records yet</Text>
            <Text style={styles.bodyText}>Once an attendance attempt is accepted by the server, it will appear here.</Text>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{items.length} recent record{items.length === 1 ? "" : "s"}</Text>
            {items.map((item, index) => {
              const session = typeof item.sessionId === "object" ? item.sessionId : null;
              const key = item._id || String(session?.sessionId || item.sessionId || index);
              return (
                <View key={key} style={styles.record}>
                  <Text style={styles.recordTitle}>
                    {item.courseCode || session?.courseCode || "Attendance"} · Section {item.section || session?.section || "—"}
                  </Text>
                  <Text style={styles.muted}>
                    {item.markedAt ? new Date(item.markedAt).toLocaleString() : "Timestamp unavailable"}
                  </Text>
                  <View style={styles.badgeRow}>
                    <VerificationBadge label="QR" value={item.verification?.qr} />
                    <VerificationBadge label="Device" value={item.verification?.device} />
                    <VerificationBadge label="Face" value={item.verification?.biometric} />
                  </View>
                </View>
              );
            })}
          </View>
        )}
        <Text style={styles.footnote}>
          Verification indicators are shown from the saved record. A green indicator does not imply that all spoofing attacks are impossible; it means the backend accepted the configured checks for that attempt.
        </Text>
      </ScrollView>
    </View>
  );
}

function VerificationBadge({ label, value }: { label: string; value?: boolean }) {
  const passed = value === true;
  return (
    <View style={[styles.badge, passed ? styles.badgePassed : styles.badgeUnknown]}>
      <Text style={[styles.badgeText, passed ? styles.badgeTextPassed : null]}>{label}: {passed ? "passed" : "not recorded"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f3f5fa" },
  content: { padding: 18, paddingTop: 28, gap: 14, paddingBottom: 40 },
  header: { flexDirection: "row", alignItems: "center", gap: 10 },
  eyebrow: { fontSize: 11, fontWeight: "800", color: "#5265a6", letterSpacing: 1.5, marginBottom: 6 },
  title: { fontSize: 25, lineHeight: 32, color: "#17223b", fontWeight: "800" },
  subtitle: { color: "#65708a", fontSize: 13, lineHeight: 19, marginTop: 5 },
  refreshButton: { borderWidth: 1, borderColor: "#cbd5e8", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  refreshText: { color: "#3157d5", fontSize: 12, fontWeight: "800" },
  card: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#e1e6f0", borderRadius: 18, padding: 16, gap: 12 },
  cardTitle: { fontSize: 16, color: "#1c2942", fontWeight: "800" },
  bodyText: { color: "#65708a", fontSize: 13, lineHeight: 20 },
  record: { borderTopWidth: 1, borderTopColor: "#edf0f6", paddingTop: 13, paddingBottom: 3, gap: 7 },
  recordTitle: { color: "#253250", fontSize: 14, fontWeight: "800" },
  muted: { color: "#77839a", fontSize: 12, lineHeight: 18 },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  badge: { borderRadius: 30, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  badgePassed: { backgroundColor: "#e9f7ef", borderColor: "#c5ecd6" },
  badgeUnknown: { backgroundColor: "#f6f7fa", borderColor: "#e1e5ed" },
  badgeText: { fontSize: 10, fontWeight: "700", color: "#717b8f" },
  badgeTextPassed: { color: "#28754e" },
  center: { alignItems: "center", justifyContent: "center", gap: 10, padding: 35 },
  errorBox: { borderRadius: 14, backgroundColor: "#fff0ee", borderWidth: 1, borderColor: "#ffd8d2", padding: 14, gap: 12 },
  errorText: { color: "#8a3932", fontSize: 13, lineHeight: 19 },
  retryButton: { backgroundColor: "#a93d35", borderRadius: 10, padding: 11, alignItems: "center" },
  retryText: { color: "#fff", fontWeight: "800" },
  footnote: { color: "#7a859b", fontSize: 11, lineHeight: 17 },
});
