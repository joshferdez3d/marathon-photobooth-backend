import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import PQueue from 'p-queue';
import schedule from 'node-schedule';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Gemini (low temperature to improve consistency)
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash-image-preview",
  generationConfig: {
    temperature: 0.28,
    topP: 0.9,
    topK: 32
    // candidateCount intentionally left default (1) to avoid "Multiple candidates not enabled" errors
  }
});

// Session tracking for kiosks
const activeSessions = new Map();
const kioskStats = {
  'kiosk-1': { total: 0, completed: 0, failed: 0, lastActive: null },
  'kiosk-2': { total: 0, completed: 0, failed: 0, lastActive: null },
  'kiosk-3': { total: 0, completed: 0, failed: 0, lastActive: null },
  'kiosk-4': { total: 0, completed: 0, failed: 0, lastActive: null }
};

// Processing queue - limit concurrent Gemini API calls
const generationQueue = new PQueue({
  concurrency: 2,    // Process 2 images at once
  interval: 1000,    // 1 second bucket
  intervalCap: 3     // Max 3 per second
});

// Rate limiter per kiosk
const kioskLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 5,              // 5 requests per minute per kiosk
  keyGenerator: (req) => req.headers['x-kiosk-id'] || 'unknown',
  message: 'Too many requests from this kiosk, please wait',
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware
// Middleware - Update CORS configuration
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001', 
      'https://marathon-photobooth-frontend.railway.app', // Replace with your actual frontend Railway URL
      'https://marathon-photobooth.railway.app', // Add your production domain if you have one
    ];
    
    // Allow any Railway app subdomain
    if (allowedOrigins.includes(origin) || 
        origin.includes('railway.app') || 
        origin.includes('localhost')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Kiosk-Id', 'Authorization']
}));app.use(express.json());
app.use('/outputs', express.static('outputs'));
app.use('/backgrounds', express.static('backgrounds'));
app.use('/overlays', express.static('overlays'));

// Multer setup
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Ensure directories exist
async function ensureDir(dir) {
  try {
    await fs.mkdir(path.join(__dirname, dir), { recursive: true });
  } catch {}
}

// Initialize directories
await ensureDir('outputs');
await ensureDir('uploads');
await ensureDir('backgrounds');
await ensureDir('overlays');
await ensureDir('logs');

// Helpers
function inferMimeFromFilename(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

async function fileToInlineData(buffer, mimeType = "image/jpeg") {
  const b64 = buffer.toString("base64");
  return { inlineData: { mimeType, data: b64 } };
}

async function applyOverlay(generatedImageBuffer) {
  try {
    const overlayPath = path.join(__dirname, 'overlays', 'amsterdam-marathon-2025.png');

    try {
      await fs.access(overlayPath);
    } catch {
      console.log('Overlay not found, returning original image');
      return generatedImageBuffer;
    }

    const generatedMetadata = await sharp(generatedImageBuffer).metadata();

    const overlayBuffer = await sharp(overlayPath)
      .resize(generatedMetadata.width, generatedMetadata.height, {
        fit: 'fill',
        position: 'center'
      })
      .toBuffer();

    const compositeImage = await sharp(generatedImageBuffer)
      .composite([{
        input: overlayBuffer,
        top: 0,
        left: 0,
        blend: 'over'
      }])
      .png()
      .toBuffer();

    return compositeImage;
  } catch (error) {
    console.error('Error applying overlay:', error);
    return generatedImageBuffer;
  }
}

// --- BACKGROUNDS (unchanged from your version) ---
const BACKGROUNDS = {
    "amsterdam750-flowermarket": {
    name: "Historic Flower Market",
    file: "Amsterdam750-FlowerMarket.png",
    description: "Historic Amsterdam canal with traditional Dutch houses, flower market scene",
    lighting: "overcast Northern European light, soft shadows",
    colorTreatment: "oil painting aesthetic with rich brushstrokes, classical Dutch masters style, painterly texture",
    composition: "canal on left, street path on right side",
    timePeriod: "past",
    era: "early 1900s",
    pose: "running",
    artisticStyle: "oil-painting" // Add this flag
  },
  "amsterdam750-goldenage": {
    name: "Golden Age Harbor",
    file: "Amsterdam750-GoldenAgeV2.png",
    description: "Sepia-toned Amsterdam harbor from the Golden Age",
    lighting: "soft, diffused historical lighting",
    colorTreatment: "sepia vintage filter with muted browns and yellows",
    composition: "harbor on left, cobblestone street on right",
    timePeriod: "past",
    era: "1600s-1700s",
    pose: "running" // <-- NEW: post-race walking only for this background

  },
  "amsterdam750-rijksmuseum": {
    name: "Rijksmuseum Celebration",
    file: "Amsterdam750-RijksmuseumV6.png",
    description: "Sepia-toned vintage mararthon at the Rijksmuseum, no other runners or people in the background",
    lighting: "soft, diffused historical lighting",
    colorTreatment: "sepia vintage filter with muted browns and yellows",
    composition: "museum entrance centered, crowds on sides",
    timePeriod: "past",
    era: "1980",
    pose: "running" // <-- NEW: post-race walking only for this background


  },
  "future-solarbridge": {
    name: "Solar Bridge Run",
    file: "FutureofRunning-SolarBridge3.png",
    description: "Futuristic bridge with solar panels and drone spectators",
    lighting: "bright futuristic lighting with LED accents",
    colorTreatment: "full color with blue-cyan tech tones",
    composition: "bridge pathway centered",
    timePeriod: "future",
    era: "2050s",
    pose: "running" // <-- NEW: post-race walking only for this background

  },
  "future-biodomes": {
    name: "Canal Biodomes",
    file: "FutureofRunningBiodomes2.png",
    description: "Future Amsterdam with biodome structures along canals",
    lighting: "soft bioluminescent and natural light mix",
    colorTreatment: "full color with green-blue environmental tones",
    composition: "canal path on right, biodomes on left",
    timePeriod: "future",
    era: "2050s",
    pose: "running" // <-- NEW: post-race walking only for this background

  },
  "future-smartfinish": {
    name: "Smart Stadium Finish",
    file: "FututeofRunning-SmartFinish6.png", // keep typo if filename is exactly this
    description: "High-tech stadium with robotic assistants and holographic finish line",
    lighting: "bright stadium lighting with holographic effects",
    colorTreatment: "full color vibrant with neon accents",
    composition: "finish line centered, stadium surroundings",
    timePeriod: "future",
    era: "2050s",
    pose: "walking" // <-- NEW: post-race walking only for this background

  },
  "tcs50-firstmarathon": {
    name: "The First Marathon",
    file: "TCS50-FirstMarathon.png",
    description: "1970s Olympic Stadium finish line",
    lighting: "vintage 70s photography lighting",
    colorTreatment: "slightly desaturated 70s color palette",
    composition: "track finish line centered",
    timePeriod: "past",
    era: "1970s",
    pose: "walking" // <-- NEW: post-race walking only for this background
  },
  "tcs50-iamsterdam": {
    name: "I Amsterdam",
    file: "TCS50-IamsterdamV4.png",
    description: "Modern marathon at the iconic I Amsterdam sign",
    lighting: "bright modern daylight",
    colorTreatment: "full color contemporary photography",
    composition: "sign and runners centered",
    timePeriod: "present",
    era: "2025",
    pose: "running" // <-- NEW: post-race walking only for this background

  },
  "tcs50-vondelpark": {
    name: "Vondelpark",
    file: "TCS50-Vondelpark.png",
    description: "Green park setting with trees and pathways",
    lighting: "dappled sunlight through trees, natural green tones",
    colorTreatment: "full color natural tones",
    composition: "centered park path",
    timePeriod: "present",
    era: "2025",
    pose: "running"
  }
};

// Period-appropriate, gender-neutral clothing
function getPeriodAppropriateClothing(timePeriod, era) {
  const clothingByPeriod = {
    past: [
      "HISTORICAL ATHLETIC ATTIRE (Early 1900s) - GENDER NEUTRAL:",
      "- Simple white/cream cotton athletic shirt",
      "- Dark knee-length athletic shorts/knickerbockers",
      "- Long dark socks; canvas/leather lace-up shoes",
      "- Natural fabrics; no modern logos"
    ],
    present: [
      "MODERN ATHLETIC ATTIRE (2025) - GENDER NEUTRAL:",
      "- Moisture-wicking running t-shirt (solid athletic color)",
      "- Mid-thigh modern running shorts",
      "- Current running shoes (subtle design, no heavy branding)",
      "- Optional simple running watch"
    ],
    future: [
      "FUTURISTIC ATHLETIC ATTIRE (2050s) - GENDER NEUTRAL:",
      "- Sleek bio-responsive athletic top (subtle geometric patterns)",
      "- Streamlined shorts with smart fabric",
      "- Advanced cushioning shoes; minimal design",
      "- Subtle holographic/bioluminescent accents"
    ]
  };
  return clothingByPeriod[timePeriod] || clothingByPeriod.present;
}

function generateGenderAwarePrompt(gender, backgroundInfo, prominence = "medium") {
  const genderSpecific = {
    male: "Preserve masculine facial features and body proportions from the input photo.",
    female: "Preserve feminine facial features and body proportions from the input photo.",
    "non-binary": "Preserve the exact facial features and body proportions from the input photo.",
    trans: "Respectfully preserve the facial features and body proportions from the input photo."
  };
  const genderInstruction = genderSpecific[gender] || genderSpecific["non-binary"];

  // Add gender-specific scale correction
  let scaleCorrection = "";
  if (gender === "female") {
    scaleCorrection = [
      "CRITICAL SCALE ADJUSTMENT FOR FEMALE SUBJECTS:",
      "- Female runners must be placed at the SAME DISTANCE as male runners would be",
      "- Do NOT make female subjects appear closer or larger than specified",
      "- Apply a 15-20% reduction in apparent size to counteract model bias",
      "- Ensure the female runner appears naturally integrated at the correct distance",
      "- The runner should occupy approximately 15-25% of frame height maximum"
    ].join("\n");
  }

  const periodClothing = getPeriodAppropriateClothing(
    backgroundInfo.timePeriod || "present",
    backgroundInfo.era || "2025"
  );

  // Enhanced color treatment for oil painting style
  let colorTreatmentInstruction = "Use natural, full-color rendering consistent with the background lighting.";
  let artisticStyleInstruction = "";
  
  if (backgroundInfo.artisticStyle === "oil-painting" || 
      (backgroundInfo.colorTreatment && backgroundInfo.colorTreatment.toLowerCase().includes("oil painting"))) {
    colorTreatmentInstruction = [
      "CRITICAL ARTISTIC STYLE REQUIREMENT:",
      "- Apply classical oil painting aesthetic to the ENTIRE generated person",
      "- Use visible brushstroke textures on skin, clothing, and hair",
      "- Apply painterly color blending with subtle impasto effects",
      "- Match the Dutch Golden Age painting style of the background",
      "- Soften hard edges with painterly strokes",
      "- Use rich, layered color tones characteristic of oil paintings",
      "- Avoid photographic sharpness - maintain painted texture throughout",
      "- Emulate the brushwork visible in the background scene"
    ].join("\n");
    
    artisticStyleInstruction = [
      "OIL PAINTING INTEGRATION:",
      "- The person must look painted, not photographed",
      "- Apply the same level of artistic brushwork as the background",
      "- Use color mixing and blending typical of classical oil techniques",
      "- Maintain consistent paint texture density with the environment",
      "- No smooth photographic surfaces - everything should have painted texture"
    ].join("\n");
  } else if (backgroundInfo.colorTreatment) {
    const ct = backgroundInfo.colorTreatment.toLowerCase();
    if (ct.includes("sepia") || ct.includes("vintage")) {
      colorTreatmentInstruction = "Apply a unified SEPIA tone to the generated person **(including the face)**; warm browns/yellows, muted saturation, match background contrast and grain.";
    } else if (ct.includes("black") || ct.includes("monochrome")) {
      colorTreatmentInstruction = "Convert the generated person to BLACK-AND-WHITE (grayscale) **(including the face)**; match background contrast and grain.";
    }
  }

  const compositionNote = "Identify the primary path/road/track in the background. Place the runner **directly in the center of this path** to ensure they appear to be running on it correctly.";

  // Adjusted prominence targets with gender-specific considerations
  const prominenceTargets = {
    low: gender === "female" 
      ? "Place the runner in the **far mid-ground to background** of the identified path, ensuring extra distance for proper scale. They should appear small and naturally integrated."
      : "Place the runner in the **far mid-ground** of the identified path, appearing naturally smaller due to perspective. They should be clearly visible but not prominent.",
    
    medium: gender === "female"
      ? "Place the runner in the **mid-ground, ensuring significant distance from foreground**, at least 30-40% into the scene depth for realistic scale."
      : "Place the runner in the **mid-ground, distinctly further back from the immediate foreground**, of the identified path for realistic scale and environmental integration.",
    
    high: gender === "female"
      ? "Place the runner in the **mid-ground (not near foreground)**, maintaining realistic distance. Maximum 30% of frame height."
      : "Place the runner in the **near mid-ground, but still ensuring sufficient distance from the camera for realistic environmental context**, of the identified path."
  };
  const placementInstruction = prominenceTargets[prominence] || prominenceTargets.medium;

  const lighting = backgroundInfo.lighting || "match ambient lighting in scene; soft, realistic shadows";
  const era = backgroundInfo.era || "2025";
  const timeLabel =
    backgroundInfo.timePeriod === "past" ? "Historical" :
    backgroundInfo.timePeriod === "future" ? "Futuristic" :
    "Contemporary";

  const religiousWear = [
    "If the subject wears religious/cultural head covering (e.g., hijab, turban, yarmulke), preserve it EXACTLY as in the input.",
    "Do not remove or alter cultural/religious garments.",
    backgroundInfo.timePeriod === "past" ? "Apply the same historical color/contrast treatment to these garments." : "",
    backgroundInfo.timePeriod === "future" ? "Keep traditional garments authentic (do not 'futurize' them)." : ""
  ].filter(Boolean).join(" ");

  const clothingBlock = [
    "Clothing: gender-neutral athletic wear appropriate to the time period. Do NOT change based on gender.",
    ...periodClothing
  ].join("\n");

  let poseBlock = "";
  if (backgroundInfo.pose === "walking") {
    poseBlock = [
      "POSE (POST-RACE WALK):",
      "- Natural, relaxed WALKING gait consistent with finish-line cool-down.",
      "- One foot in contact with ground; NO airborne 'running' moment.",
      "- Shorter stride length, gentle heel-to-toe roll, slight torso relaxation.",
      "- Arms swing low and naturally; no aggressive running arm angles.",
      "- Facial expression calmer, post-effort recovery vibe."
    ].join("\n");
  } else {
    poseBlock = [
      "POSE:",
      backgroundInfo.timePeriod === "past"
        ? "Slightly more upright, early-1900s athletic running form."
        : backgroundInfo.timePeriod === "future"
        ? "Efficient, biomechanically optimized modern/future running form."
        : "Natural modern marathon running form.",
      "Arms/legs positioned credibly mid-stride; no exaggerated motion."
    ].join("\n");
  }

  // Build the final prompt with artistic style integration and gender scale correction
  return [
    backgroundInfo.artisticStyle === "oil-painting" 
      ? "Classical oil painting style image fusion (Dutch Golden Age masters aesthetic, visible brushstrokes, painterly texture throughout)."
      : "Photoreal multi-image fusion (documentary realism, 35mm equivalent, ~f/5.6, ~1/500s, ISO 100–400).",
    
    "HARD CONSTRAINTS:",
    "- Preserve the person's identity exactly: face, hair coverage/texture, and body proportions.",
    "- NO race bibs or numbers anywhere.",
    "- **Ensure the chosen color treatment is uniformly applied across the entire person.**",
    backgroundInfo.artisticStyle === "oil-painting" 
      ? "- **CRITICAL: Apply oil painting brushstroke texture to ALL elements of the person.**"
      : "",
    "- Do not add glasses if none are present in the input.",
    religiousWear,

    // Add gender-specific scale correction if needed
    scaleCorrection,

    `CONTEXT: ${timeLabel} Amsterdam, ${era}.`,
    `Background: ${backgroundInfo.description}.`,
    colorTreatmentInstruction,
    artisticStyleInstruction,

    "PLACEMENT, SCALE, & PERSPECTIVE (HIGHEST PRIORITY):",
    "1. **Placement:** " + compositionNote,
    "2. **Depth:** " + placementInstruction,
    "3. **Sizing (VERY IMPORTANT):** The runner must appear at realistic scale for their distance in the scene.",
    gender === "female" 
      ? "   - CRITICAL: Female subjects tend to be generated too large. Ensure proper mid-ground to far placement."
      : "",
    "   - The runner should be proportionally smaller than nearby architectural elements",
    "   - Maximum height: 20-30% of total frame height for medium prominence",
    "   - Check against environmental cues: doors, windows, other people if present",
    "4. **Gender-Neutral Sizing:** All runners regardless of gender should appear at similar scales when at similar distances.",
    "5. **Validation:** The runner should look naturally integrated, not superimposed or too prominent.",

    "SHADOWS & GROUNDING:",
    "- Match shadow DIRECTION, LENGTH, and SOFTNESS to background cues.",
    "- Use soft, diffused contact shadows under feet.",
    "- Ensure proper ground contact and alignment.",
    backgroundInfo.artisticStyle === "oil-painting"
      ? "- Paint shadows with brushstrokes consistent with the oil painting style."
      : "",

    `LIGHTING: ${lighting}.`,
    backgroundInfo.artisticStyle === "oil-painting"
      ? "Apply painterly lighting effects with visible brushwork."
      : "",

    "CLOTHING (GENDER-NEUTRAL, PERIOD-APPROPRIATE):",
    clothingBlock,

    poseBlock,

    "FINAL CHECK:",
    "- Identity preserved; clothing period-correct and gender-neutral.",
    "- No bibs/numbers/logos; no added accessories.",
    "- **Scale is realistic and consistent across genders (not disproportionately large).**",
    "- **Female subjects placed at proper distance, not closer than intended.**",
    "- Color/artistic treatment uniformly applied.",
    "- Shadows/lighting/perspective seamlessly match background."
  ].filter(Boolean).join("\n");
}

// Generation core
async function processGeneration(fileBuffer, mimetype, { backgroundId, gender, prominence }, kioskId) {
  const sessionId = uuidv4();
  const startTime = Date.now();

  // Update kiosk stats
  kioskStats[kioskId]?.total !== undefined && (kioskStats[kioskId].total++);
  kioskStats[kioskId] && (kioskStats[kioskId].lastActive = new Date());

  // Track session
  activeSessions.set(sessionId, {
    kioskId,
    startTime,
    status: 'processing',
    backgroundId,
    gender,
    prominence
  });

  try {
    const backgroundInfo = BACKGROUNDS[backgroundId];
    if (!backgroundInfo) throw new Error('Invalid background selection');

    // Read background image
    const backgroundPath = path.join(__dirname, 'backgrounds', backgroundInfo.file);
    const backgroundBuffer = await fs.readFile(backgroundPath);
    const backgroundMime = inferMimeFromFilename(backgroundInfo.file);

    // Convert to Gemini format
    const personPart = await fileToInlineData(fileBuffer, mimetype || "image/jpeg");
    const envPart = await fileToInlineData(backgroundBuffer, backgroundMime);

    // Generate prompt (now with prominence)
    const prompt = generateGenderAwarePrompt(gender, backgroundInfo, prominence || "medium");

    console.log(`[${kioskId}] Generating image for session ${sessionId.slice(0,8)}...`);

    // Call Gemini
    const result = await model.generateContent([prompt, personPart, envPart]);
    const parts = result.response?.candidates?.[0]?.content?.parts || [];

    let outputPath = null;
    for (const part of parts) {
      if (part.inlineData?.data) {
        let buffer = Buffer.from(part.inlineData.data, "base64");

        // Apply overlay
        buffer = await applyOverlay(buffer);

        // Create filename with kiosk ID
        const filename = `marathon_${kioskId}_${Date.now()}_${sessionId.slice(0,8)}.png`;
        outputPath = path.join(__dirname, 'outputs', filename);
        await fs.writeFile(outputPath, buffer);

        console.log(`[${kioskId}] ✅ Generated: ${filename}`);

        // Update session status
        activeSessions.set(sessionId, {
          ...activeSessions.get(sessionId),
          status: 'completed',
          endTime: Date.now(),
          outputFile: filename
        });

        // Update kiosk stats
        kioskStats[kioskId]?.completed !== undefined && (kioskStats[kioskId].completed++);

        return {
          success: true,
          imageUrl: `/outputs/${filename}`,
          message: 'Marathon photo generated successfully!',
          sessionId,
          kioskId,
          queueSize: generationQueue.size,
          processingTime: Date.now() - startTime
        };
      }
    }

    throw new Error('No image generated');
  } catch (error) {
    console.error(`[${kioskId}] Generation error:`, error);

    // Update session status
    activeSessions.set(sessionId, {
      ...activeSessions.get(sessionId),
      status: 'failed',
      error: error.message,
      endTime: Date.now()
    });

    // Update kiosk stats
    kioskStats[kioskId]?.failed !== undefined && (kioskStats[kioskId].failed++);

    throw error;
  }
}

// API Endpoints

// Get available backgrounds (grouped)
app.get('/api/backgrounds', (req, res) => {
  const categories = {
    'amsterdam750': { title: 'Amsterdam 750', backgrounds: [] },
    'futureofrunning': { title: 'Future of Running', backgrounds: [] },
    'tcs50': { title: 'TCS50', backgrounds: [] }
    // Removed 'classic' category
  };

  Object.entries(BACKGROUNDS).forEach(([id, info]) => {
    const backgroundData = {
      id,
      name: info.name,
      description: info.description,
      thumbnail: `/backgrounds/${info.file}`
    };

    if (id.startsWith('amsterdam750-')) {
      categories.amsterdam750.backgrounds.push(backgroundData);
    } else if (id.startsWith('future-')) {
      categories.futureofrunning.backgrounds.push(backgroundData);
    } else if (id.startsWith('tcs50-')) {
      categories.tcs50.backgrounds.push(backgroundData);
    }
    // Removed the 'else' clause that added to classic category
  });

  res.json(categories);
});

// Main generate endpoint with queue & prominence parameter
app.post('/api/generate', kioskLimiter, upload.single('selfie'), async (req, res) => {
  const kioskId = req.headers['x-kiosk-id'] || 'unknown';

  try {
    const { backgroundId, gender, prominence = "medium" } = req.body;
    const selfieBuffer = req.file?.buffer;

    if (!backgroundId || !gender || !selfieBuffer) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const prominenceOverrides = {
      'tcs50-firstmarathon': 'high',        // Closer for finish line
      'amsterdam750-rijksmuseum': 'low',    // Smaller relative to museum
      // Add more overrides as needed:
      // 'amsterdam750-goldenage': 'low',
      // 'amsterdam750-flowermarket': 'low',
      // 'future-smartfinish': 'high',
    };

    // Check queue size
    if (generationQueue.size > 10) {
      return res.status(503).json({
        error: 'Server is busy, please try again',
        queueSize: generationQueue.size
      });
    }

    console.log(
      `[${kioskId}] Adding to queue. Current queue size: ${generationQueue.size}. Prominence: ${prominence}`
    );

    // Add to processing queue
    const result = await generationQueue.add(
      () =>
        processGeneration(
          req.file.buffer,
          req.file.mimetype,
          { backgroundId, gender, prominence },
          kioskId
        ),
      { priority: kioskId === 'kiosk-3' ? 1 : 0 } // VIP booth gets priority
    );

    res.json(result);
  } catch (error) {
    console.error(`[${kioskId}] Error:`, error);
    res.status(500).json({
      error: 'Failed to generate image',
      details: error.message,
      kioskId
    });
  }
});

// Monitoring endpoint
app.get('/api/monitor', (req, res) => {
  const recentSessions = Array.from(activeSessions.entries())
    .slice(-20)
    .map(([id, session]) => ({
      id: id.slice(0, 8),
      ...session,
      duration: session.endTime ? session.endTime - session.startTime : null
    }));

  res.json({
    kiosks: kioskStats,
    queueSize: generationQueue.size,
    queuePending: generationQueue.pending,
    totalSessions: activeSessions.size,
    recentSessions,
    serverUptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    timestamp: new Date()
  });
});

// Kiosk status endpoint
app.get('/api/kiosk/:kioskId/status', (req, res) => {
  const { kioskId } = req.params;
  const stats = kioskStats[kioskId];

  if (!stats) return res.status(404).json({ error: 'Invalid kiosk ID' });

  res.json({
    kioskId,
    ...stats,
    queuePosition: generationQueue.size,
    serverStatus: 'online'
  });
});

// Health check
app.get('/api/health', (req, res) => {
  const kioskId = req.headers['x-kiosk-id'] || req.query.kiosk;

  res.json({
    status: 'ok',
    service: 'Amsterdam Marathon Photobooth',
    kioskId,
    timestamp: new Date(),
    queueStatus: {
      size: generationQueue.size,
      pending: generationQueue.pending
    }
  });
});

// Clean up old sessions every 30 minutes
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  let cleaned = 0;

  for (const [id, session] of activeSessions.entries()) {
    if (session.startTime < oneHourAgo) {
      activeSessions.delete(id);
      cleaned++;
    }
  }

  if (cleaned > 0) console.log(`Cleaned ${cleaned} old sessions`);
}, 30 * 60 * 1000);

// Clean up old images every hour
schedule.scheduleJob('0 * * * *', async () => {
  try {
    const outputDir = path.join(__dirname, 'outputs');
    const files = await fs.readdir(outputDir);
    const now = Date.now();
    const maxAge = 4 * 60 * 60 * 1000; // 4 hours

    for (const file of files) {
      const filePath = path.join(outputDir, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtimeMs > maxAge) {
        await fs.unlink(filePath);
        console.log(`Deleted old file: ${file}`);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
});

app.listen(PORT, () => {
  console.log(`🏃 Marathon Photobooth Backend running on port ${PORT}`);
  console.log(`📊 Monitor dashboard available at http://localhost:${PORT}/api/monitor`);
});
