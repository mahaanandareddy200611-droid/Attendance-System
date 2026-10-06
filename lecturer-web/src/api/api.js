import axios from "axios";

const api = axios.create({
    baseURL: "http://localhost:3000"
});

api.interceptors.request.use( // before request goes out.   interceptors → Axios's checkpoint
    (config) => { //handles a successful request configuration.

        const token = localStorage.getItem("token");

        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }

        return config;
    },

    (error) => {
        console.log(error)
        return Promise.reject(error);
    }
);

export default api;