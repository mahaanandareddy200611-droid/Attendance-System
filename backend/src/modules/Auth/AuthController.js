const asyncHandler = require("../../middlewares/asyncHandler")
const authservice = require("./AuthService")

exports.Signup = asyncHandler(async(req,res)=>{
        const {name,RollNumber,email,password,role,faceImage_url,mobileNumber} =req.body //defining them at here to validate

        const data =await authservice.Signup(name,RollNumber,email,password,role,faceImage_url,mobileNumber)
        
        
        console.log("New user created")
        return res.status(201).json({
            success:true,
            message:" you had created an account",
            data:{
                id:data._id,
                email:data.email,
                RollNumber:data.RollNumber,
                name:data.Name,
                mobileNumber:data.mobileNumber,
                role:data.role,
                faceImage_url:data.faceImage_url
            }
            
        })

    })

exports.Login = asyncHandler(async (req, res) => {

    const {
        email,
        password
    } = req.body;

    const data = await authservice.Login(
        email,
        password
    );

    console.log("User logged in");

    return res.status(200).json({
        success: true,
        message: "Login successful",
        data: {
            id: data.user._id,
            email: data.user.email,
            RollNumber: data.user.RollNumber,
            name: data.user.Name,
            mobileNumber: data.user.mobileNumber,
            role: data.user.role,
            faceImage_url: data.user.faceImage_url
        },
        token: data.token
    });
});