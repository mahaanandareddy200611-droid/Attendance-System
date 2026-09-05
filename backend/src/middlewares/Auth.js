const jwt = require("jsonwebtoken");
const AppError = require("../utils/AppError");

const Auth = async(req , res, next)=>{
    
        // here we get token like this 
        const AuthHeader = req.headers.authorization;

        if(!AuthHeader){
            console.log("token does not exist ")
            throw new AppError("token not found! , please Login again",401)
        }

        if(!AuthHeader.startsWith("Bearer ")){
            throw new AppError("Invalid authorization format.",401);
            
        }
        const token = AuthHeader.split(" ")[1];
        // now we have token lets verify it .
        try{
        const verfiedToken = jwt.verify(token,process.env.JWT_SECRET);
        //    this was not needed because jwt.verify diretly does this job! it checks:
        //   token authentic?   secret correct?   token expired?  token modified? 

        req.user = verfiedToken;
        next();
        }catch(error){
            throw new AppError("Invalid or expired token, please login again",401)
        }
    }
module.exports=Auth;