import express from "express";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import path from "path";
import fs from "fs";
import cors from "cors";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import streamifier from "streamifier";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors({
    origin: true,
    credentials: true
  }));
  app.use(express.json());
  
  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Add headers for iframe compatibility
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Credentials', 'true');
    next();
  });

  // Ensure uploads directory exists
  const uploadsDir = path.join(process.cwd(), "public", "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Configure Multer for file storage (Image to URL)
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, uniqueSuffix + path.extname(file.originalname));
    },
  });

  const uploadDisk = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  });

  // Configure Multer for memory storage (Processing Tools)
  const memoryStorage = multer.memoryStorage();
  const uploadMemory = multer({
    storage: memoryStorage,
    limits: { fileSize: 100 * 1024 * 1024 }, // Increased to 100MB to match disk limit
  });

  // Configure Cloudinary
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  // API Routes
  // Note: All uploads are stored permanently on the server disk.
  // No expiration logic is implemented, ensuring links remain valid indefinitely.
  app.get("/api/auth-check", (req, res) => {
    res.send(`
      <html>
        <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 20px;">
          <h1 style="font-size: 20px;">Connection Verified</h1>
          <p>You can now close this window and return to the app.</p>
          <button onclick="window.close()" style="padding: 10px 20px; cursor: pointer; background: #2563EB; color: white; border: none; rounded: 5px; font-weight: bold;">Close Window</button>
          <script>
            // Try to close automatically if possible
            setTimeout(() => {
              if (window.opener) {
                window.opener.postMessage({ type: 'AUTH_SUCCESS' }, '*');
                window.close();
              }
            }, 2000);
          </script>
        </body>
      </html>
    `);
  });

  // 0. Image to URL (Existing)
  app.post("/api/upload", uploadMemory.single("image"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Check if Cloudinary is configured
    const isCloudinaryConfigured = process.env.CLOUDINARY_CLOUD_NAME && 
                                  process.env.CLOUDINARY_API_KEY && 
                                  process.env.CLOUDINARY_API_SECRET;

    if (isCloudinaryConfigured) {
      try {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "tooldack_uploads",
            resource_type: "auto",
          },
          (error, result) => {
            if (error) {
              console.error("Cloudinary upload error:", error);
              return res.status(500).json({ error: "Failed to upload to Cloudinary" });
            }
            res.json({
              url: result?.secure_url,
              filename: result?.public_id,
              size: result?.bytes,
              mimetype: result?.format,
              provider: "cloudinary"
            });
          }
        );

        streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    } else {
      // Fallback to local disk storage
      try {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const filename = uniqueSuffix + path.extname(req.file.originalname);
        const filePath = path.join(uploadsDir, filename);
        
        fs.writeFileSync(filePath, req.file.buffer);

        const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
        const fileUrl = `${appUrl}/u/${filename}`;

        res.json({
          url: fileUrl,
          filename: filename,
          size: req.file.size,
          mimetype: req.file.mimetype,
          provider: "local"
        });
      } catch (err: any) {
        res.status(500).json({ error: "Local storage failed: " + err.message });
      }
    }
  });

  // 1. Image to PDF Converter
  app.post("/api/image-to-pdf", uploadMemory.array("images", 20), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) return res.status(400).json({ error: "No files uploaded" });

      const pdfDoc = await PDFDocument.create();
      
      for (const file of files) {
        // Convert all images to JPEG for maximum compatibility with pdf-lib
        const jpegBuffer = await sharp(file.buffer).jpeg().toBuffer();
        const image = await pdfDoc.embedJpg(jpegBuffer);
        
        const page = pdfDoc.addPage([image.width, image.height]);
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      }

      const pdfBytes = await pdfDoc.save();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=converted.pdf');
      res.send(Buffer.from(pdfBytes));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. Background Remover
  app.post("/api/remove-bg", uploadMemory.single("image"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const apiKey = process.env.REMOVE_BG_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "REMOVE_BG_API_KEY not configured" });

      const formData = new FormData();
      formData.append('image_file', new Blob([req.file.buffer]), req.file.originalname);
      formData.append('size', 'auto');

      const response = await axios.post('https://api.remove.bg/v1.0/removebg', formData, {
        headers: { 'X-Api-Key': apiKey },
        responseType: 'arraybuffer'
      });

      res.setHeader('Content-Type', 'image/png');
      res.send(response.data);
    } catch (err: any) {
      let errorMessage = err.message;
      if (err.response?.data) {
        try {
          // If responseType was arraybuffer, we need to convert it back to string to see the error
          const errorData = Buffer.from(err.response.data).toString();
          const parsedError = JSON.parse(errorData);
          errorMessage = parsedError.errors?.[0]?.title || parsedError.error || errorData;
        } catch (e) {
          errorMessage = Buffer.from(err.response.data).toString();
        }
      }
      res.status(500).json({ error: errorMessage });
    }
  });

  // 3. Image Compressor
  app.post("/api/compress", uploadMemory.single("image"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const quality = parseInt(req.body.quality as string) || 80;
      
      const metadata = await sharp(req.file.buffer).metadata();
      const format = metadata.format;

      let pipeline = sharp(req.file.buffer);

      if (format === 'png') {
        // For PNG, we use palette-based compression which is very effective
        pipeline = pipeline.png({ quality, palette: true, colors: 256 });
      } else if (format === 'webp') {
        pipeline = pipeline.webp({ quality });
      } else {
        // Default to JPEG for others
        pipeline = pipeline.jpeg({ quality, mozjpeg: true });
      }

      const buffer = await pipeline.toBuffer();
      res.setHeader('Content-Type', `image/${format === 'png' ? 'png' : format === 'webp' ? 'webp' : 'jpeg'}`);
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. JPG <-> PNG Converter
  app.post("/api/convert-format", uploadMemory.single("image"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const targetFormat = req.body.format === 'png' ? 'png' : 'jpeg';
      
      let pipeline = sharp(req.file.buffer);
      if (targetFormat === 'png') pipeline = pipeline.png();
      else pipeline = pipeline.jpeg();

      const buffer = await pipeline.toBuffer();
      res.setHeader('Content-Type', `image/${targetFormat}`);
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. WebP Converter
  app.post("/api/webp-convert", uploadMemory.single("image"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const quality = parseInt(req.body.quality as string) || 80;
      
      const buffer = await sharp(req.file.buffer)
        .webp({ quality })
        .toBuffer();

      res.setHeader('Content-Type', 'image/webp');
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. Resize Tool
  app.post("/api/resize", uploadMemory.single("image"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const width = parseInt(req.body.width as string) || null;
      const height = parseInt(req.body.height as string) || null;
      
      const buffer = await sharp(req.file.buffer)
        .resize(width, height, { fit: 'inside' })
        .toBuffer();

      res.setHeader('Content-Type', req.file.mimetype);
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. Image to Prompt (Gemini Vision) - MOVED TO FRONTEND
  app.post("/api/image-to-prompt", (req, res) => {
    res.status(410).json({ error: "This endpoint has been moved to the frontend for security and performance. Please update your client." });
  });

  // 8. Watermark Adder
  app.post("/api/watermark", uploadMemory.single("image"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const text = req.body.text || "Watermark";
      const opacity = parseFloat(req.body.opacity as string) || 0.5;

      const metadata = await sharp(req.file.buffer).metadata();
      const width = metadata.width || 800;
      const height = metadata.height || 600;
      const format = metadata.format || 'jpeg';

      // Escape special characters for SVG
      const escapedText = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

      const svgText = `
        <svg width="${width}" height="${height}">
          <style>
            .title { 
              fill: white; 
              font-size: ${Math.floor(width / 10)}px; 
              font-weight: bold; 
              opacity: ${opacity};
              font-family: sans-serif;
            }
          </style>
          <text 
            x="50%" 
            y="50%" 
            text-anchor="middle" 
            dominant-baseline="middle"
            class="title"
          >${escapedText}</text>
        </svg>
      `;

      let pipeline = sharp(req.file.buffer)
        .composite([{ input: Buffer.from(svgText), gravity: 'center' }]);

      // Ensure we output in the same format as input
      if (format === 'png') pipeline = pipeline.png();
      else if (format === 'webp') pipeline = pipeline.webp();
      else pipeline = pipeline.jpeg();

      const buffer = await pipeline.toBuffer();

      res.setHeader('Content-Type', `image/${format === 'jpeg' ? 'jpeg' : format}`);
      res.send(buffer);
    } catch (err: any) {
      console.error("Watermark error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // 9. Rotate / Flip Tool
  app.post("/api/rotate", uploadMemory.single("image"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const angle = parseInt(req.body.angle as string) || 0;
      const flip = req.body.flip === 'true';
      const flop = req.body.flop === 'true';
      
      let pipeline = sharp(req.file.buffer).rotate(angle);
      if (flip) pipeline = pipeline.flip();
      if (flop) pipeline = pipeline.flop();

      const buffer = await pipeline.toBuffer();
      res.setHeader('Content-Type', req.file.mimetype);
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve uploaded files
  app.use("/uploads", express.static(uploadsDir));
  app.use("/u", express.static(uploadsDir));

  // Error handler for Multer and other errors
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(err);
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    res.status(500).json({ error: err.message || "Internal server error" });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production: serve static files from dist
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
