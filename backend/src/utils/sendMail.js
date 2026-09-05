const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASSWORD
    }
});

const sendMail = async ({
    to,
    subject,
    text,
    html
}) => {

    const info = await transporter.sendMail({
        from: `"Attendence-System" <${process.env.MAIL_USER}>`,
        to,
        subject,
        text,
        html
    });

    console.log("Email sent:", info.messageId);

    return info;
};

module.exports = {
    sendMail
};