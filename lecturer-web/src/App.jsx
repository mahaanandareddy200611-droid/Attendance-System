import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import ProtectedRoute from "./auth/ProtectedRoute";

const Dashboard = lazy(() => import("./Pages/dashboard"));
const AdminAcademic = lazy(() => import("./Pages/AdminAcademic"));
const AdminUsers = lazy(() => import("./Pages/AdminUsers"));
const AttendanceReports = lazy(() => import("./Pages/AttendanceReports"));
const LecturerAcademic = lazy(() => import("./Pages/LecturerAcademic"));
const LecturerAttendance = lazy(() => import("./Pages/LecturerAttendance"));
const LecturerSessionResults = lazy(
  () => import("./Pages/LecturerSessionResults"),
);
const StudentAcademic = lazy(() => import("./Pages/StudentAcademic"));
const Login = lazy(() => import("./Pages/Login"));
const Signup = lazy(() => import("./Pages/Signup"));
const ForgotPassword = lazy(() => import("./Pages/ForgotPassword"));

const admin = (page) => (
  <ProtectedRoute roles={["Admin"]}>{page}</ProtectedRoute>
);
const lecturer = (page) => (
  <ProtectedRoute roles={["Lecturer"]}>{page}</ProtectedRoute>
);
const student = (page) => (
  <ProtectedRoute roles={["Student"]}>{page}</ProtectedRoute>
);

export default function App() {
  return (
    <AuthProvider>
      <Suspense
        fallback={
          <p className="route-loading" role="status">
            Loading page…
          </p>
        }
      >
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />

          <Route
            path="/admin"
            element={<Navigate to="/admin/dashboard" replace />}
          />
          <Route path="/admin/dashboard" element={admin(<AdminAcademic />)} />
          <Route path="/admin/academic" element={admin(<AdminAcademic />)} />
          <Route path="/admin/courses" element={admin(<AdminAcademic />)} />
          <Route path="/admin/sections" element={admin(<AdminAcademic />)} />
          <Route path="/admin/enrollments" element={admin(<AdminAcademic />)} />
          <Route path="/admin/users" element={admin(<AdminUsers />)} />
          <Route path="/admin/reports" element={admin(<AttendanceReports />)} />

          <Route path="/dashboard" element={lecturer(<Dashboard />)} />
          <Route
            path="/lecturer"
            element={<Navigate to="/lecturer/dashboard" replace />}
          />
          <Route path="/lecturer/dashboard" element={lecturer(<Dashboard />)} />
          <Route
            path="/lecturer/academic"
            element={lecturer(<LecturerAcademic />)}
          />
          <Route
            path="/lecturer/sections"
            element={lecturer(<LecturerAcademic />)}
          />
          <Route
            path="/lecturer/sections/:sectionId"
            element={lecturer(<LecturerAcademic />)}
          />
          <Route
            path="/lecturer/attendance"
            element={lecturer(<LecturerAttendance />)}
          />
          <Route
            path="/lecturer/sessions/new"
            element={lecturer(<LecturerAttendance />)}
          />
          <Route
            path="/lecturer/sessions/:sessionId/live"
            element={lecturer(<LecturerAttendance />)}
          />
          <Route
            path="/lecturer/sessions/:sessionId/attendance"
            element={lecturer(<LecturerSessionResults />)}
          />
          <Route
            path="/lecturer/reports"
            element={lecturer(<AttendanceReports />)}
          />

          <Route
            path="/student"
            element={<Navigate to="/student/dashboard" replace />}
          />
          <Route
            path="/student/academic"
            element={student(<StudentAcademic />)}
          />
          <Route
            path="/student/dashboard"
            element={student(<StudentAcademic />)}
          />

          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
