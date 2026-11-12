require("dotenv").config();
const express=require("express"),cors=require("cors"),path=require("path"),fs=require("fs");
const app=express(),PORT=process.env.PORT||3000,HOST=process.env.HOST||'0.0.0.0';
const db=require("./db"),{ensureAssessmentWorkflowSchema}=require("./schema-compat");
app.use(cors());app.use(express.json({limit:"4mb"}));app.use(express.urlencoded({extended:true}));app.use((req,res,next)=>{if(req.path.startsWith("/api/")){res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","private, no-store");}next();});
app.use((req,res,next)=>{if(req.path.endsWith(".html"))res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");next();});app.use(express.static(path.join(__dirname,"..","public")));fs.mkdirSync(path.join(__dirname,"..","uploads"),{recursive:true});app.use('/uploads',express.static(path.join(__dirname,'..','uploads')));
app.get("/api/health",async(req,res)=>{try{await db.query("SELECT 1");res.json({ok:true,app:"ZELIMU CBC",version:"4.0.9",database:"connected",timestamp:new Date().toISOString()});}catch(e){res.status(503).json({ok:false,app:"ZELIMU CBC",version:"4.0.9",database:"unavailable",error:e.message,timestamp:new Date().toISOString()});}});
app.use("/api/auth",require("./routes/auth"));
app.use("/api/platform",require("./routes/platform"));
app.use("/api/school",require("./routes/school"));
app.use("/api/settings",require("./routes/settings"));
app.use("/api/people",require("./routes/people"));
app.use("/api/assessments",require("./routes/assessments"));
app.use("/api/grading",require("./routes/grading"));
app.use("/api/merit-flex",require("./routes/merit-flex"));
app.use("/api/subject-deviation",require("./routes/subject-deviation"));
app.use("/api/merit",require("./routes/merit"));
app.use("/api/merit-weight-profiles",require("./routes/merit-v6-profiles"));
app.use("/api/merit-v6-term",require("./routes/merit-v6-term"));
app.use("/api/reports",require("./routes/reports"));
app.use("/api/results-centre",require("./routes/results-centre"));
app.use("/api/documents",require("./routes/documents"));
app.use("/api/communications",require("./routes/communications"));
app.use("/api/billing",require("./routes/billing"));
app.use("/api/finance",require("./routes/finance"));
app.use("/api/school-documents",require("./routes/school-documents"));
app.use("/api/school-certificates",require("./routes/school-certificates"));
app.use("/api/operations",require("./routes/operations"));
app.use("/api/biometrics",require("./routes/biometrics"));
app.use("/api/timetable-generator",require("./routes/timetable-generator"));
app.use("/api/timetable-config",require("./routes/timetable-config"));
app.use("/api/resources",require("./routes/resources"));
app.use("/api/extended",require("./routes/extended"));app.use("/api/docx-import",require("./routes/docx-import"));
app.use("/api", (req,res)=>res.status(404).json({error:"API endpoint not found",method:req.method,path:req.originalUrl}));
app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"..","public","index.html")));
app.use((err,req,res,next)=>{console.error("Unhandled request error:",err);if(res.headersSent)return next(err);if(req.path.startsWith("/api/"))return res.status(err.status||500).json({error:err.message||"Internal server error."});return res.status(err.status||500).send("Internal server error.");});
// Open the HTTP port immediately so Render can detect the service.
// Database compatibility checks continue in the background.
const server = app.listen(PORT, HOST, () => {
  console.log(`ZELIMU CBC listening on ${HOST}:${PORT}`);
});

(async () => {
  try {
    console.log("ZELIMU CBC: checking database compatibility...");
    await ensureAssessmentWorkflowSchema();
    await require("./extended-schema")();
    console.log("ZELIMU CBC: database compatibility checks completed.");
  } catch (e) {
    console.error("ZELIMU CBC database compatibility check failed:", e);
    // Keep the server running so health checks can report database status.
  }
})();
