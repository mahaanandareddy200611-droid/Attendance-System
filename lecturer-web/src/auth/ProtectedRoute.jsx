import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./useAuth";

const homeByRole = {
  Admin: "/admin/academic",
  Lecturer: "/dashboard",
  Student: "/student/academic",
};

export default function ProtectedRoute({ roles, children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <p role="status">Checking your session…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (roles && !roles.includes(user.role)) {
    return <Navigate to={homeByRole[user.role] || "/login"} replace />;
  }

  return children;
}
