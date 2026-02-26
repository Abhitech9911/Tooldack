# Netlify Deployment Guide

To deploy this app to Netlify, follow these steps:

## 1. Environment Variables
Go to **Site settings > Environment variables** in your Netlify dashboard and add the following:

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Your Google Gemini API Key |
| `REMOVE_BG_API_KEY` | Your Remove.bg API Key |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary Cloud Name |
| `CLOUDINARY_API_KEY` | Cloudinary API Key |
| `CLOUDINARY_API_SECRET` | Cloudinary API Secret |
| `APP_URL` | Your Netlify site URL (e.g., `https://your-site.netlify.app`) |

## 2. Backend Limitation
**Important:** Netlify is a static hosting platform. The Express server (`server.ts`) will **not** run on Netlify automatically. 

- **Frontend:** Will work perfectly (UI, Gemini AI integration).
- **Backend Tools:** Features like "Image to URL" (local storage), "PDF Converter", and "Image Compressor" rely on the Express server.
- **Recommendation:** For full functionality (Express + Node.js), consider deploying to **Render**, **Railway**, or **Heroku**. 

If you must use Netlify, you would need to convert the API routes in `server.ts` into **Netlify Functions**.

## 3. Build Settings
The `netlify.toml` file already configures these for you:
- **Build Command:** `npm run build`
- **Publish Directory:** `dist`
- **Node Version:** 20
