import { useCallback, useEffect, useState } from "react";
import WorkspaceHeader from "../components/WorkspaceHeader";
import {
  approveBiometricEnrollment,
  getPendingBiometricEnrollments,
  rejectBiometricEnrollment,
} from "../services/biometric.service";
import { useAuth } from "../auth/useAuth";
import "../Styles/Academic.css";

function apiMessage(error, fallback) {
  return error?.response?.data?.error?.message ||
    error?.response?.data?.message || error?.message || fallback;
}

export default function BiometricEnrollmentApprovals() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeStudent, setActiveStudent] = useState("");
  const [notice, setNotice] = useState(null);

  const fetchPending = useCallback(async () => {
    const response = await getPendingBiometricEnrollments();
    return Array.isArray(response?.data?.data) ? response.data.data : [];
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      setItems(await fetchPending());
    } catch (error) {
      setNotice({ type: "error", text: apiMessage(error, "Could not load pending face enrollments.") });
    } finally {
      setLoading(false);
    }
  }, [fetchPending]);

  useEffect(() => {
    let active = true;
    fetchPending()
      .then((rows) => { if (active) setItems(rows); })
      .catch((error) => {
        if (active) setNotice({ type: "error", text: apiMessage(error, "Could not load pending face enrollments.") });
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [fetchPending]);

  const review = async (item, decision) => {
    if (activeStudent) return;
    if (decision === "reject" && !window.confirm(
      `Reject face enrollment for ${item.name || item.rollNumber || "this student"}? The stored biometric enrollment will be deleted from the provider.`
    )) return;
    setActiveStudent(String(item.studentId));
    setNotice(null);
    try {
      if (decision === "approve") {
        await approveBiometricEnrollment(item.studentId);
        setNotice({ type: "success", text: `Face enrollment approved for ${item.name || item.rollNumber || "the student"}. They can scan a live QR and complete face/liveness verification.` });
      } else {
        await rejectBiometricEnrollment(item.studentId);
        setNotice({ type: "success", text: `Face enrollment rejected for ${item.name || item.rollNumber || "the student"}; provider deletion was confirmed.` });
      }
      setItems((current) => current.filter((entry) => String(entry.studentId) !== String(item.studentId)));
    } catch (error) {
      setNotice({ type: "error", text: apiMessage(error, "The review action failed. Refresh to see the server's current status.") });
      try {
        const response = await getPendingBiometricEnrollments();
        setItems(Array.isArray(response?.data?.data) ? response.data.data : []);
      } catch { /* Keep the actionable error visible. */ }
    } finally {
      setActiveStudent("");
    }
  };

  return (
    <main className="academic-page">
      <WorkspaceHeader />
      <section className="academic-content">
        <div className="academic-heading">
          <div>
            <p className="academic-eyebrow">BIOMETRIC ACCESS CONTROL</p>
            <h1>Face enrollment approvals</h1>
            <p>Review student submissions before their face profile can be used for attendance. Approval is enforced by the backend.</p>
          </div>
          <span className="academic-role">{user?.role || "Reviewer"}</span>
        </div>
        {notice && <div className={"academic-notice " + notice.type} role={notice.type === "error" ? "alert" : "status"}>{notice.text}</div>}
        <section className="academic-card">
          <div className="academic-card-title">
            <span className="academic-step">REVIEW</span>
            <div><h2>Pending submissions</h2><p>Only pending records within your review permissions are returned by the server.</p></div>
            <button type="button" className="academic-button secondary" onClick={() => void load()} disabled={loading || Boolean(activeStudent)}>{loading ? "Refreshing…" : "Refresh"}</button>
          </div>
          {loading ? <p className="academic-empty" role="status">Loading enrollment requests…</p> :
            items.length === 0 ? <div className="academic-empty-state"><div className="academic-empty-icon" aria-hidden="true">✓</div><h2>No pending face enrollments</h2><p>New student submissions appear after the biometric provider accepts an enrollment image.</p></div> :
            <div className="enrollment-approval-list">
              {items.map((item) => {
                const busy = String(activeStudent) === String(item.studentId);
                return <article className="enrollment-approval-item" key={item.studentId}>
                  <div className="enrollment-approval-details">
                    <strong>{item.name || "Student"}{item.rollNumber ? ` · ${item.rollNumber}` : ""}</strong>
                    <p>{item.email || "No email returned"} · Submitted {item.enrolledAt ? new Date(item.enrolledAt).toLocaleString() : "time unavailable"}</p>
                    <span>{(item.sections || []).length ? item.sections.map((section) => `${section.courseCode || "Course"} · ${section.sectionName || "Section"}`).join(" | ") : "No active class enrollment is linked to this request."}</span>
                  </div>
                  <div className="enrollment-approval-actions">
                    <button type="button" className="academic-button" onClick={() => void review(item, "approve")} disabled={Boolean(activeStudent)}>{busy ? "Processing…" : "Approve enrollment"}</button>
                    <button type="button" className="academic-button danger" onClick={() => void review(item, "reject")} disabled={Boolean(activeStudent)}>{busy ? "Processing…" : "Reject and delete"}</button>
                  </div>
                </article>;
              })}
            </div>}
        </section>
      </section>
    </main>
  );
}
