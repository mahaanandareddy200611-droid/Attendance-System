"use strict";
function endpoint(base,part){let u;try{u=new URL(String(base||""));}catch{throw Error("STAGING_BASE_URL must be a valid HTTP(S) URL");}if(!["https:","http:"].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error("STAGING_BASE_URL must not contain credentials, query, or fragment");const p=u.pathname.replace(/\/+$/,"");u.pathname=`${p.endsWith("/api/v1")?p:p+"/api/v1"}/${part}`.replace(/\/{2,}/g,"/");return u;}
async function runDeploymentSmoke({baseUrl=process.env.STAGING_BASE_URL,fetchImpl=globalThis.fetch,requireBiometric=String(process.env.ATTENDANCE_REQUIRE_BIOMETRIC||"").toLowerCase()==="true"}={}){
 if(!baseUrl)throw Error("Set STAGING_BASE_URL to the deployed API URL");
 const result={};
 for(const name of ["livez","health","readyz"]){let response;try{response=await fetchImpl(endpoint(baseUrl,name),{headers:{accept:"application/json"},signal:AbortSignal.timeout(8000)});}catch{throw Error(`/api/v1/${name} could not be reached`);}
 let body;try{body=await response.json();}catch{throw Error(`/api/v1/${name} did not return JSON`);}
 if(!response.ok||body.success!==true)throw Error(`/api/v1/${name} is not healthy (${body.status||response.status})`);
 if(name==="livez"&&body.status!=="alive")throw Error("Invalid liveness status");
 if(name==="health"&&body.status!=="healthy")throw Error("Invalid health status");
 if(name==="readyz"){if(body.status!=="ready"||body.dependencies?.mongodb!==true||body.dependencies?.redis!==true)throw Error("Readiness did not confirm MongoDB and Redis");if(requireBiometric&&body.dependencies?.biometricProvider!==true)throw Error("Readiness did not confirm biometric provider");if(body.requirements?.privateStorage&&body.dependencies?.privateObjectStorage!==true)throw Error("Readiness did not confirm private storage");if(body.requirements?.email&&body.dependencies?.email!==true)throw Error("Readiness did not confirm email configuration");}
 result[name]={status:response.status,state:body.status};
 }return result;
}
if(require.main===module)runDeploymentSmoke().then(r=>{for(const [k,v] of Object.entries(r))console.log(`PASS ${k}: HTTP ${v.status}, ${v.state}`);}).catch(e=>{console.error("STAGING SMOKE FAILED:",e.message);process.exitCode=1;});
module.exports={buildEndpointUrl:endpoint,runDeploymentSmoke};
