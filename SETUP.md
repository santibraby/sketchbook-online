# Sketchbook Online — Setup & Deploy Guide

## What You Need (all free tier)
- **Supabase** account → supabase.com
- **Vercel** account → vercel.com
- **Google Cloud Console** → console.cloud.google.com (for OAuth)
- **Node.js 18+** installed locally

---

## Step 1: Create Supabase Project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Pick a name (e.g. "sketchbook") and set a database password
3. Wait for it to provision (~2 min)
4. Go to **Settings → API** and copy:
   - `Project URL` → this is your `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → this is your `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## Step 2: Run the Database Schema

1. In Supabase dashboard, go to **SQL Editor**
2. Open `supabase-schema.sql` from this project folder
3. Paste the entire contents and click **Run**
4. This creates the `projects` and `project_members` tables with RLS policies

## Step 3: Create Storage Bucket

1. In Supabase dashboard, go to **Storage**
2. Click **New Bucket**
3. Name: `project-assets`
4. Toggle **Public bucket** ON
5. Click **Create bucket**
6. Go to **Policies** for that bucket and add:
   - **SELECT**: allow for everyone (public read) — `true`
   - **INSERT**: allow for authenticated users — `auth.role() = 'authenticated'`
   - **UPDATE**: allow for authenticated users — `auth.role() = 'authenticated'`
   - **DELETE**: allow for authenticated users — `auth.role() = 'authenticated'`

## Step 4: Set Up Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Go to **APIs & Services → Credentials**
4. Click **Create Credentials → OAuth Client ID**
5. Application type: **Web application**
6. Add authorized redirect URI:
   ```
   https://YOUR_SUPABASE_PROJECT_REF.supabase.co/auth/v1/callback
   ```
   (Find your project ref in Supabase → Settings → General)
7. Copy the **Client ID** and **Client Secret**
8. In Supabase dashboard, go to **Authentication → Providers → Google**
9. Toggle it ON, paste the Client ID and Client Secret, and Save

## Step 5: Local Development

1. Open a terminal in this folder (`sketchbook online`)

2. Create `.env.local`:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIs...
   ```

3. Install dependencies:
   ```
   npm install
   ```

4. Run dev server:
   ```
   npm run dev
   ```

5. Open http://localhost:3000

6. For Google OAuth to work locally, add `http://localhost:3000/auth/callback` to your Google OAuth redirect URIs AND add `http://localhost:3000` to your Supabase Auth settings under **Site URL** (Authentication → URL Configuration).

## Step 6: Deploy to Vercel

1. Push this folder to a GitHub repo
2. Go to [vercel.com](https://vercel.com) → New Project → Import the repo
3. Add environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Deploy
5. Copy your Vercel deployment URL (e.g. `https://sketchbook-xxx.vercel.app`)
6. Update Google OAuth redirect URI to include:
   ```
   https://YOUR_SUPABASE_PROJECT_REF.supabase.co/auth/v1/callback
   ```
7. In Supabase → Authentication → URL Configuration:
   - Set **Site URL** to your Vercel URL
   - Add your Vercel URL to **Redirect URLs**

---

## Project Structure

```
sketchbook online/
├── package.json
├── tsconfig.json
├── next.config.js
├── .env.example
├── .gitignore
├── supabase-schema.sql          ← Run this in Supabase SQL Editor
├── SETUP.md                     ← This file
└── src/
    ├── middleware.ts             ← Session refresh on every request
    ├── types/
    │   └── database.ts          ← TypeScript types
    ├── lib/
    │   ├── supabase-browser.ts  ← Client-side Supabase
    │   └── supabase-server.ts   ← Server-side Supabase
    └── app/
        ├── layout.tsx           ← Root layout (fonts, meta)
        ├── globals.css          ← Global dark theme styles
        ├── page.tsx             ← Landing page (auth + project list)
        ├── page.module.css      ← Landing page styles
        ├── auth/
        │   └── callback/
        │       └── route.ts     ← OAuth callback handler
        └── canvas/
            ├── page.tsx         ← Canvas workspace (the big one)
            └── canvas.css       ← Canvas styles
```

## How Sharing Works

1. Project owner shares via email (feature to add in UI)
2. A row is added to `project_members` with the invited email
3. When that person signs in with Google, RLS policies automatically match their email
4. The shared project appears in their project list
5. They can edit (role = 'editor') but not delete

## Costs

All free tier:
- **Supabase Free**: 500MB database, 1GB storage, 50K monthly auth users
- **Vercel Free**: 100GB bandwidth, serverless functions included
- More than enough for personal/small team use
