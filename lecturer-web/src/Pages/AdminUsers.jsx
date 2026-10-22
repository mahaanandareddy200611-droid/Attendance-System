import { useEffect, useState } from "react";
import { CreateLecturer } from "../services/auth.service";
import { searchAcademicUsers } from "../services/academic.service";
import { getApiErrorMessage } from "../api/errors";
import "../Styles/Academic.css";
import WorkspaceHeader from "../components/WorkspaceHeader";

const emptyForm = {
  name: "",
  email: "",
  mobileNumber: "",
  password: "",
};

export default function AdminUsers() {
  const [form, setForm] = useState(emptyForm);
  const [lecturers, setLecturers] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadLecturers = async () => {
    setListLoading(true);
    try {
      const response = await searchAcademicUsers({ role: "Lecturer", limit: 100 });
      setLecturers(Array.isArray(response.data?.data) ? response.data.data : []);
      setError("");
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Could not load lecturer accounts."));
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    searchAcademicUsers({ role: "Lecturer", limit: 100 })
      .then((response) => {
        if (active) setLecturers(response.data.data || []);
      })
      .catch((requestError) => {
        if (active)
          setError(
            getApiErrorMessage(
              requestError,
              "Could not load lecturer accounts.",
            ),
          );
      })
      .finally(() => {
        if (active) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await CreateLecturer(form);
      setMessage(response.data.message || "Lecturer account created.");
      setForm(emptyForm);
      await loadLecturers();
    } catch (requestError) {
      setError(
        getApiErrorMessage(requestError, "Could not create lecturer account."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="academic-page">
      <WorkspaceHeader />
      <section className="academic-content">
        <div className="academic-heading">
          <div>
            <p className="academic-eyebrow">ADMINISTRATION</p>
            <h1>Lecturer accounts</h1>
            <p>Only an authenticated Admin can provision Lecturer accounts.</p>
          </div>
          <span className="academic-role">Admin</span>
        </div>

        {message && (
          <p className="academic-notice success" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="academic-notice error" role="alert">
            {error}
          </p>
        )}

        <form className="academic-card admin-user-form" onSubmit={submit}>
          <h2>Create Lecturer account</h2>
          <label className="academic-field">
            <span>Name</span>
            <input
              autoComplete="name"
              minLength={2}
              maxLength={100}
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
              required
            />
          </label>
          <label className="academic-field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={(event) =>
                setForm({ ...form, email: event.target.value })
              }
              required
            />
          </label>
          <label className="academic-field">
            <span>Mobile number</span>
            <input
              type="tel"
              inputMode="numeric"
              pattern="[0-9]{10}"
              maxLength={10}
              value={form.mobileNumber}
              onChange={(event) =>
                setForm({ ...form, mobileNumber: event.target.value })
              }
              required
            />
          </label>
          <label className="academic-field">
            <span>Initial password</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={form.password}
              onChange={(event) =>
                setForm({ ...form, password: event.target.value })
              }
              required
            />
            <small>
              Share the initial password through your institution’s private
              channel.
            </small>
          </label>
          <button className="academic-button" disabled={busy}>
            {busy ? "Creating…" : "Create Lecturer"}
          </button>
        </form>

        <section className="academic-card">
          <h2>Active Lecturers</h2>
          {listLoading ? (
            <p className="academic-empty" role="status">Loading Lecturer accounts…</p>
          ) : lecturers.length ? (
            <div className="academic-table-wrap">
              <table className="academic-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                  </tr>
                </thead>
                <tbody>
                  {lecturers.map((lecturer) => (
                    <tr key={lecturer._id}>
                      <td>{lecturer.Name}</td>
                      <td>{lecturer.email}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : error ? (
            <div>
              <p className="academic-empty">The Lecturer list could not be loaded.</p>
              <button className="academic-button secondary" type="button" onClick={loadLecturers} disabled={listLoading}>
                Retry loading accounts
              </button>
            </div>
          ) : (
            <p className="academic-empty">No active Lecturer accounts were found.</p>
          )}
        </section>
      </section>
    </main>
  );
}
