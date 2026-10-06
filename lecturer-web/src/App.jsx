
import { Routes, Route, Navigate } from "react-router-dom";

import Login from "./Pages/Login";
import Signup from "./Pages/Signup";
import ForgotPassword from "./Pages/ForgotPassword";

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />

      <Route path="*" element={<Navigate to="/login" />} />
    </Routes>
  );
}

export default App;