import { useEffect, useState } from "react";
import QRCode from "qrcode";
import axios from "axios";

function App() {

    const [bearerToken, setBearerToken] = useState("");
    const [sessionId, setSessionId] = useState("");

    const [qrImage, setQrImage] = useState("");
    const [qrToken, setQrToken] = useState("");

    const [error, setError] = useState("");

    const fetchQR = async () => {

        if (!bearerToken || !sessionId) {
            return;
        }

        try {

            const response = await axios.get(
                `http://localhost:3000/attendance/sessions/${sessionId}/qr`,
                {
                    headers: {
                        Authorization: `Bearer ${bearerToken}`
                    }
                }
            );

            const token =
                response.data.data.token;

            setQrToken(token);

            const image =
                await QRCode.toDataURL(token, {
                    width: 350,
                    margin: 2
                });

            setQrImage(image);

            setError("");

        } catch (error) {

            console.error(error);

            setError(
                error.response?.data?.message ||
                "Failed to fetch QR"
            );
        }
    };


    useEffect(() => {

        if (!bearerToken || !sessionId) {
            return;
        }

        fetchQR();

        const interval = setInterval(
            fetchQR,
            300
        );

        return () => {
            clearInterval(interval);
        };

    }, [bearerToken, sessionId]);


    return (
        <div
            style={{
                textAlign: "center",
                padding: "30px"
            }}
        >

            <h1>
                Dynamic Attendance QR
            </h1>


            <input
                type="text"
                placeholder="JWT Token"
                value={bearerToken}
                onChange={(e) =>
                    setBearerToken(e.target.value)
                }
                style={{
                    width: "500px",
                    padding: "10px"
                }}
            />

            <br />
            <br />


            <input
                type="text"
                placeholder="Session ID"
                value={sessionId}
                onChange={(e) =>
                    setSessionId(e.target.value)
                }
                style={{
                    width: "500px",
                    padding: "10px"
                }}
            />

            <br />
            <br />


            {error && (
                <p style={{ color: "red" }}>
                    {error}
                </p>
            )}


            {qrImage && (
                <>
                    <img
                        src={qrImage}
                        alt="Dynamic Attendance QR"
                        width="350"
                    />

                    <p>
                        QR updates every 300ms
                    </p>

                    <details>
                        <summary>
                            Current QR Token
                        </summary>

                        <textarea
                            value={qrToken}
                            readOnly
                            rows={4}
                            cols={50}
                        />
                    </details>
                </>
            )}

        </div>
    );
}

export default App;