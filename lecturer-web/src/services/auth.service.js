import api from "../api/api";

export const Signup = (data)=>{
    return api.post("/auth/signup",data)
}

export const Login = (data)=>{
    return api.post("/auth/login",data)
}

export const ForgotPassword = (data)=>{
    return api.post("/auth/forget-password",data)
}

export const VerifyOtp = (data)=>{
    return api.post("/auth/verify-reset-otp",data)
}
export const SetPassword = (data)=>{
    return api.post("/auth/reset-password",data)
}
