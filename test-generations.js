import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  serverUrl: 'http://localhost:3001',
  testImagesDir: path.join(__dirname, 'test-images'),
  outputDir: path.join(__dirname, 'test-outputs'),
  kioskId: 'test-script',
  testsPerBackground: 3,
  requestDelay: 2000,  // 13 seconds = ~4.6 requests per minute (safely under 5/min limit)
  defaultConfigs: [
    { gender: 'male', prominence: 'medium' },
    { gender: 'female', prominence: 'medium' },
    { gender: 'non-binary', prominence: 'medium' },
    { gender: 'male', prominence: 'low' },
    { gender: 'female', prominence: 'high' },
  ]
};

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function ensureDirectories() {
  await fs.mkdir(CONFIG.testImagesDir, { recursive: true });
  await fs.mkdir(CONFIG.outputDir, { recursive: true });
  log(`✓ Directories ready`, 'green');
}

async function getTestImages() {
  try {
    const files = await fs.readdir(CONFIG.testImagesDir);
    const imageFiles = files.filter(f => 
      /\.(jpg|jpeg|png|webp)$/i.test(f)
    );
    
    if (imageFiles.length === 0) {
      log(`⚠️  No images found in ${CONFIG.testImagesDir}`, 'yellow');
      log(`   Please add test images (jpg, jpeg, png, or webp) to the test-images folder`, 'yellow');
      return [];
    }
    
    return imageFiles.sort(() => Math.random() - 0.5);
  } catch (error) {
    log(`❌ Error reading test images: ${error.message}`, 'red');
    return [];
  }
}

async function getBackgrounds() {
  try {
    const response = await fetch(`${CONFIG.serverUrl}/api/backgrounds`, {
      headers: {
        'X-Kiosk-Id': CONFIG.kioskId
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const categories = await response.json();
    const backgrounds = [];
    
    for (const [categoryKey, category] of Object.entries(categories)) {
      for (const bg of category.backgrounds) {
        backgrounds.push(bg);
      }
    }
    
    return backgrounds;
  } catch (error) {
    log(`❌ Error fetching backgrounds: ${error.message}`, 'red');
    log(`   Make sure the server is running on ${CONFIG.serverUrl}`, 'yellow');
    return [];
  }
}

async function generateImage(imagePath, backgroundId, config, imageName) {
  try {
    const imageBuffer = await fs.readFile(imagePath);
    const formData = new FormData();
    
    // FIX: Detect MIME type from file extension
    const ext = path.extname(imagePath).toLowerCase();
    let mimeType = 'image/jpeg';
    if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.webp') mimeType = 'image/webp';
    else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    
    // Create blob with correct MIME type
    const blob = new Blob([imageBuffer], { type: mimeType });
    formData.append('selfie', blob, path.basename(imagePath));
    formData.append('backgroundId', backgroundId);
    formData.append('gender', config.gender);
    formData.append('prominence', config.prominence);
    
    const response = await fetch(`${CONFIG.serverUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'X-Kiosk-Id': CONFIG.kioskId
      },
      body: formData
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || errorData.message || `HTTP ${response.status}`);
    }
    
    const result = await response.json();
    
    if (result.imageUrl) {
      const imageResponse = await fetch(`${CONFIG.serverUrl}${result.imageUrl}`);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      
      const outputFilename = `${imageName}_${backgroundId}_${config.gender}.png`;
      const outputPath = path.join(CONFIG.outputDir, outputFilename);
      await fs.writeFile(outputPath, imageBuffer);
      
      return { success: true, filename: outputFilename, processingTime: result.processingTime };
    }
    
    return { success: false, error: 'No image URL in response' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  log('\n🚀 Starting Marathon Photobooth Test Generator', 'bright');
  log('═══════════════════════════════════════════════\n', 'cyan');
  
  await ensureDirectories();
  
  log('📸 Loading test images...', 'blue');
  const allTestImages = await getTestImages();
  
  if (allTestImages.length === 0) {
    return;
  }
  
  log(`   Found ${allTestImages.length} test image(s)`, 'green');
  
  if (allTestImages.length < CONFIG.testsPerBackground) {
    log(`   ⚠️  Warning: You have fewer images than tests per background`, 'yellow');
    log(`   Some images will be reused for different backgrounds\n`, 'yellow');
  } else {
    log(`   Each background will be tested with ${CONFIG.testsPerBackground} different people\n`, 'green');
  }
  
  log('🎨 Fetching available backgrounds...', 'blue');
  const backgrounds = await getBackgrounds();
  
  if (backgrounds.length === 0) {
    return;
  }
  
  log(`   Found ${backgrounds.length} background(s)\n`, 'green');
  
  const totalGenerations = backgrounds.length * CONFIG.testsPerBackground;
  const estimatedTime = Math.ceil((totalGenerations * CONFIG.requestDelay) / 1000 / 60);
  
  log(`📊 Will generate ${totalGenerations} total images`, 'cyan');
  log(`   (${backgrounds.length} backgrounds × ${CONFIG.testsPerBackground} tests each)`, 'cyan');
  log(`   ⏱️  Estimated time: ~${estimatedTime} minutes\n`, 'yellow');
  
  const stats = {
    total: 0,
    successful: 0,
    failed: 0,
    totalTime: 0,
    byBackground: {}
  };
  
  const startTime = Date.now();
  let imageIndex = 0;
  
  for (let bgIndex = 0; bgIndex < backgrounds.length; bgIndex++) {
    const background = backgrounds[bgIndex];
    
    stats.byBackground[background.id] = { successful: 0, failed: 0 };
    
    log(`\n${'═'.repeat(60)}`, 'cyan');
    log(`🎨 BACKGROUND ${bgIndex + 1}/${backgrounds.length}: ${background.name}`, 'bright');
    log(`   ID: ${background.id}`, 'cyan');
    log(`${'═'.repeat(60)}\n`, 'cyan');
    
    for (let testNum = 1; testNum <= CONFIG.testsPerBackground; testNum++) {
      const imageFile = allTestImages[imageIndex % allTestImages.length];
      const imagePath = path.join(CONFIG.testImagesDir, imageFile);
      const imageName = path.parse(imageFile).name;
      
      const config = CONFIG.defaultConfigs[imageIndex % CONFIG.defaultConfigs.length];
      
      const progress = `[${stats.total + 1}/${totalGenerations}]`;
      
      log(`${progress} Test ${testNum}/${CONFIG.testsPerBackground}: ${imageFile}`, 'yellow');
      log(`          Gender: ${config.gender} | Prominence: ${config.prominence}`, 'magenta');
      
      const result = await generateImage(
        imagePath, 
        background.id, 
        config, 
        imageName, 
        testNum
      );
      
      stats.total++;
      
      if (result.success) {
        stats.successful++;
        stats.byBackground[background.id].successful++;
        stats.totalTime += result.processingTime || 0;
        log(`          ✓ Success! Saved as: ${result.filename}`, 'green');
        log(`          ⏱️  Processing time: ${result.processingTime}ms\n`, 'cyan');
      } else {
        stats.failed++;
        stats.byBackground[background.id].failed++;
        log(`          ✗ Failed: ${result.error}\n`, 'red');
      }
      
      imageIndex++;
      
      if (testNum < CONFIG.testsPerBackground || bgIndex < backgrounds.length - 1) {
        log(`          ⏳ Waiting ${CONFIG.requestDelay/1000}s to respect rate limits...`, 'blue');
        await delay(CONFIG.requestDelay);
      }
    }
  }
  
  const totalElapsed = Date.now() - startTime;
  const avgTime = stats.successful > 0 ? Math.round(stats.totalTime / stats.successful) : 0;
  
  log(`\n${'═'.repeat(60)}`, 'cyan');
  log('📈 TEST SUMMARY', 'bright');
  log(`${'═'.repeat(60)}`, 'cyan');
  log(`Total generations: ${stats.total}`, 'cyan');
  log(`✓ Successful: ${stats.successful}`, 'green');
  log(`✗ Failed: ${stats.failed}`, stats.failed > 0 ? 'red' : 'green');
  log(`⏱️  Average processing time: ${avgTime}ms`, 'cyan');
  log(`⏱️  Total elapsed time: ${Math.round(totalElapsed / 1000 / 60)} minutes`, 'cyan');
  log(`📁 Output directory: ${CONFIG.outputDir}`, 'blue');
  
  log(`\n📊 Results by Background:`, 'cyan');
  for (const [bgId, bgStats] of Object.entries(stats.byBackground)) {
    const bgName = backgrounds.find(b => b.id === bgId)?.name || bgId;
    log(`   ${bgName}: ${bgStats.successful}/${CONFIG.testsPerBackground} successful`, 
        bgStats.successful === CONFIG.testsPerBackground ? 'green' : 'yellow');
  }
  
  log(`${'═'.repeat(60)}\n`, 'cyan');
  
  if (stats.successful > 0) {
    log('✨ Test generation complete! Check the test-outputs folder for results.', 'green');
    log(`\n💡 Tip: Files are named: backgroundId_test#_personName_gender.png`, 'blue');
  }
}

runTests().catch(error => {
  log(`\n❌ Fatal error: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});