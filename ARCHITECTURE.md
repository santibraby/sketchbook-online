# Sketchbook Online Architecture

A practical reference for modifying and extending the Sketchbook Online web app.

---

## 1. Overview

**Sketchbook Online** is a collaborative canvas-based sketching application built with **Next.js 14 (App Router)**, **Supabase** (PostgreSQL + Auth + Storage), and deployed on **Vercel**.

It's a web port of the desktop Electron version with the same object model and canvas engine, but adapted for the browser with cloud storage and real-time collaboration.

### Key Tech Stack
- **Framework**: Next.js 14 with App Router, React 18, TypeScript
- **Backend**: Supabase (Postgres DB, OAuth 2.0, S3-compatible Storage, Realtime)
- **Hosting**: Vercel (serverless functions)
- **Auth**: Google OAuth via Supabase
- **Storage**: Supabase Storage (`project-assets` bucket)
- **Real-time Sync**: Supabase Postgres Changes

---

## 2. File Map

| File | Lines | Description |
|------|-------|-------------|
| `src/app/page.tsx` | 352 | Landing page: project list, create/delete, sign in/out |
| `src/app/canvas/page.tsx` | 2200+ | Main canvas workspace: IIFE engine in useEffect, all tools, save/realtime |
| `src/app/canvas/canvas.css` | 579 | Canvas styles: viewport, objects, tools, animations |
| `src/app/layout.tsx` | ~20 | Root layout, global styles |
| `src/lib/supabase-browser.ts` | 8 | Browser client initialization |
| `src/lib/supabase-server.ts` | 20 | Server client for API routes (cookies-based auth) |
| `src/middleware.ts` | 28 | Auth session refresh on every request |
| `src/app/auth/callback/route.ts` | 30 | OAuth callback: exchanges auth code for session |
| `src/app/api/invite/route.ts` | 70 | POST /api/invite: adds member to project, sends email invite |
| `src/types/database.ts` | 77 | TypeScript types for projects & project_members tables |
| `supabase-schema.sql` | 196 | Database schema: tables, RLS policies, indexes, triggers |
| `package.json` | 24 | Dependencies (Next.js, React, Supabase, TypeScript) |

---

## 3. Infrastructure

### Supabase Setup

#### Authentication
- **Provider**: Google OAuth 2.0
- **Flow**: Sign in button → Google popup → callback route → session cookies
- **Session Storage**: Secure httpOnly cookies managed by Supabase SSR library
- **Refresh**: Middleware runs on every request to auto-refresh sessions

#### Database (PostgreSQL)
- **Tables**:
  - `projects`: canvas projects owned by users
  - `project_members`: collaboration invites and member access
- **Row Level Security (RLS)**: All tables use RLS to enforce access control
- **Triggers**: Auto-update `updated_at` on projects table

#### Storage
- **Bucket**: `project-assets` (public read, authenticated write)
- **Path Format**: `{projectId}/{timestamp}.jpg`
- **URLs**: Generated via Supabase's `getPublicUrl()` API
- **Policies**: Authenticated users can upload/read; user can delete own files

#### Realtime
- **Subscriptions**: Postgres Changes on `projects` table
- **Event**: `UPDATE` events notify all clients when project data changes
- **Guard**: `lastSaveTime` check to prevent processing own saves

### Vercel Hosting
- **Deployment**: Git push to main branch triggers auto-deploy
- **Functions**: API routes in `src/app/api/*` become serverless functions
- **Environment**: Env vars set in Vercel dashboard (NEXT_PUBLIC_* for client-side)

---

## 4. Environment Variables

All 3 required environment variables must be set in `.env.local` and Vercel dashboard:

```bash
# Public — baked into client bundle
NEXT_PUBLIC_SUPABASE_URL=https://yourproject.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...  # Public anon key from Supabase

# Server-only — API routes only (never sent to client)
SUPABASE_SERVICE_ROLE_KEY=eyJ...      # Service role key for admin operations (invites)
```

**Why 3 vars?**
- Public key: Used by browser client for queries within RLS bounds
- Service role key: Used by API routes to bypass RLS (e.g., invite users)

---

## 5. Auth Flow

### Sign In (page.tsx)
```
User clicks "Sign in with Google"
↓
supabase.auth.signInWithOAuth({ provider: 'google', redirectTo: '/auth/callback' })
↓
Google popup opens, user authorizes
↓
Google redirects to /auth/callback?code=...
```

### Callback (auth/callback/route.ts)
```
GET /auth/callback?code=...&state=...
↓
extractCodeFromURL()
↓
supabase.auth.exchangeCodeForSession(code)  // Server-side
↓
Cookies set by Supabase SSR (httpOnly, secure)
↓
Redirect to home or ?next=/canvas?project=...
```

### Session Persistence
- **Middleware** runs on every request
- Calls `supabase.auth.getUser()` to refresh session if expired
- Cookie Store gets updated automatically by Supabase SSR
- Client-side: Use `supabase.auth.getSession()` to check if logged in

---

## 6. Database Schema

### projects Table
```sql
id UUID PRIMARY KEY (gen_random_uuid())
name TEXT NOT NULL
owner_id UUID NOT NULL -> auth.users(id) ON DELETE CASCADE
canvas_state JSONB { panX, panY, zoom }
objects JSONB [ { id, type, x, y, w, h, ... } ]
created_at TIMESTAMPTZ DEFAULT now()
updated_at TIMESTAMPTZ DEFAULT now()
```

### project_members Table
```sql
id UUID PRIMARY KEY
project_id UUID NOT NULL -> projects(id) ON DELETE CASCADE
user_id UUID -> auth.users(id) ON DELETE CASCADE
email TEXT NOT NULL
role TEXT DEFAULT 'editor'  -- 'editor' (read/write) or 'viewer' (read-only)
invited_at TIMESTAMPTZ DEFAULT now()
UNIQUE(project_id, email)
```

### RLS Policies (Simplified)

**projects table:**
- **INSERT**: Only if `owner_id = current_user`
- **SELECT**: If `owner_id = current_user` OR user is in `project_members` with matching email/user_id
- **UPDATE**: If `owner_id = current_user` OR in `project_members` with role='editor'
- **DELETE**: Only if `owner_id = current_user`

**project_members table:**
- **INSERT**: Only if project owner
- **SELECT**: Members can see their own memberships
- **DELETE**: Only project owner can remove members

---

## 7. Storage

### Upload Path Format
```
project-assets / {projectId} / {timestamp}.jpg
```

Example: `d4a3f1e9-2c0b-4f13-a2bb-5e1d9c3f7a2e/1710965432189.jpg`

### Image Upload Process (canvas/page.tsx)

1. **Client-side resize** (if > 2MB or not JPEG):
   - Use Canvas API to draw image
   - `canvas.toBlob()` → compress to JPEG 0.85-0.9 quality
   - Max dimension: 1200px

2. **Upload to Supabase**:
   ```typescript
   const path = `${projectId}/${Date.now()}.jpg`;
   await supabase.storage.from('project-assets').upload(path, file);
   ```

3. **Generate Public URL**:
   ```typescript
   const { data } = supabase.storage
     .from('project-assets')
     .getPublicUrl(path);
   // Returns: https://yourproject.supabase.co/storage/v1/object/public/...
   ```

4. **Render in Canvas**:
   ```html
   <img src={publicUrl} crossOrigin="anonymous" />
   ```
   - `crossOrigin="anonymous"` required for `sampleColorAtScreen()` (eyedropper tool)

### Storage Policies
- Authenticated users can upload to `project-assets`
- All users can read from `project-assets` (public bucket)
- Users can only delete their own files (via `owner` field)

---

## 8. Canvas Page Architecture

The canvas is a **hybrid React + vanilla JS approach**:

### React Layer (page.tsx)
- Handles auth check: redirect if not logged in
- Loads project from Supabase on mount
- Sets up Suspense wrapper
- Returns JSX skeleton with refs and empty divs

### Vanilla JS IIFE (useEffect)
The actual engine runs as an **async IIFE** inside a useEffect:
```typescript
useEffect(() => {
  (async () => {
    // All canvas logic here: tools, rendering, saving, realtime
  })();
}, [projectId]);
```

**Why?** The engine is proven & battle-tested from the desktop version. Re-implementing in React would be risky; this keeps it unchanged.

### Engine Initialization Guard
```typescript
const engineInitialized = useRef(false);
if (engineInitialized.current) return;
engineInitialized.current = true;
```
Prevents double-initialization if projectId changes within same component lifecycle.

### DOM References
```typescript
const viewportRef = useRef<HTMLDivElement>(null);  // Pan/zoom container
const worldRef = useRef<HTMLDivElement>(null);     // Canvas objects (transformed)
const gridLayerRef = useRef<HTMLDivElement>(null); // Snapping grid
const samplerCanvasRef = useRef<HTMLCanvasElement>(null); // Eyedropper color sampling
```

### State Management (all in IIFE closure)
```typescript
let panX = 0, panY = 0, zoom = 1;           // Viewport
let objects: CanvasObject[] = [];           // Canvas objects
let selectedIds = new Set<number>();       // Selection
let activeTool = 'pointer';                 // Current tool
let spaceDown = false;                      // Pan mode
let cropState: { objId: number } | null;   // Crop mode
let undoStack: string[] = [];               // Undo/redo
let redoStack: string[] = [];
```

### How Images Work

**Desktop (Electron)**: Images stored as local file paths → `file://C:/...`

**Web (Supabase)**:
1. Upload image → Supabase Storage
2. Get public URL → `https://supabase.../storage/v1/object/public/project-assets/...`
3. Set `<img src={url} crossOrigin="anonymous" />`

**Key difference**: `crossOrigin="anonymous"` is required for eyedropper to read pixel data via canvas `drawImage()`.

### How Save Works
```typescript
async function saveProject() {
  const { error } = await supabase
    .from('projects')
    .update({
      objects: JSON.parse(JSON.stringify(objects)),
      canvas_state: { panX, panY, zoom },
    })
    .eq('id', projectId);
  // Show "Saved" indicator for 1.5s
}
```

**Debouncing**: Save triggered after 500ms of inactivity:
```typescript
function markDirty() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveProject(), 500);
}
```

### How Image Upload Works
```typescript
async function uploadImage(file: File, projectId: string, supabase: any) {
  // 1. Resize if needed
  if (file.size > 2 * 1024 * 1024) {
    imageFile = await resizeImage(file); // Canvas API, max 1200px
  }

  // 2. Convert to JPEG if not already
  if (file.type !== 'image/jpeg') {
    imageFile = await convertToJpeg(file); // White background
  }

  // 3. Get dimensions
  const { width, height } = await getImageDimensions(imageFile);

  // 4. Upload to Storage
  const path = `${projectId}/${Date.now()}.jpg`;
  await supabase.storage.from('project-assets').upload(path, imageFile);

  // 5. Return path & dimensions for canvas object
  return { path, width, height };
}
```

### Triggering Save
```typescript
// Auto-save on any change
markDirty();

// Manual save
document.querySelector('[data-toolbar="save"]')?.addEventListener('click', () => saveProject());

// Save on exit
window.addEventListener('beforeunload', () => {
  if (objects.length > 0) saveProject();
});

// Ctrl+S
if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
  e.preventDefault();
  saveProject();
}
```

---

## 9. Realtime Sync

### Subscription Setup (lines 1906–1945)
```typescript
const channel = supabase
  .channel(`project-${projectId}`)
  .on(
    'postgres_changes',
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'projects',
      filter: `id=eq.${projectId}`,
    },
    (payload: any) => {
      // Handle update from another client
    }
  )
  .subscribe();
```

### lastSaveTime Guard
```typescript
let lastSaveTime = 0;

const originalSaveProject = saveProject;
saveProject = async function() {
  lastSaveTime = Date.now();
  return originalSaveProject();
};

// In realtime callback:
if (Date.now() - lastSaveTime < 2000) {
  console.log('Ignoring own save');
  return;
}
```

**Why?** Supabase broadcasts the UPDATE event to *all* clients, including the one that triggered it. The 2-second window prevents processing your own save.

### On Remote Update
```typescript
// Reload objects from payload, keep local viewport state
objects = (newData.objects || []).map(normalizeObject);
nextId = objects.length ? Math.max(...objects.map(o => o.id)) + 1 : 1;
selectedIds.clear();
renderObjects();

// Flash "Synced" indicator
saveIndicator.textContent = 'Synced';
saveIndicator.classList.add('show');
setTimeout(() => {
  saveIndicator.textContent = 'Saved';
  saveIndicator.classList.remove('show');
}, 1500);
```

**Key**: Only objects are updated, NOT pan/zoom. Each user keeps their own viewport.

---

## 10. Project Sharing

### Share Flow

**1. Click "Share" button**
```typescript
openSharePopup(); // Show modal with email input
```

**2. Enter email, click "Invite"**
```typescript
const res = await fetch('/api/invite', {
  method: 'POST',
  body: JSON.stringify({ projectId, email }),
});
```

**3. API Route (/api/invite/route.ts)**
```typescript
// Verify requester owns the project
const { data: project } = await supabaseUser
  .from('projects')
  .select('id, owner_id')
  .eq('id', projectId)
  .eq('owner_id', user.id);

// Add to project_members (using service role to bypass RLS)
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
await supabaseAdmin.from('project_members').upsert({
  project_id: projectId,
  email: email.toLowerCase(),
  role: 'editor',
}, { onConflict: 'project_id,email' });

// Send magic link invitation email
await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
  redirectTo: `/auth/callback?next=/canvas?project=${projectId}`,
});
```

**4. Invited User Receives Email**
- Email contains magic link
- Clicking link redirects to `/auth/callback?next=...`
- Auth callback sets session cookie
- Redirects to canvas page with project ID

### Accessing Shared Projects

**Landing page queries**:
```typescript
// Shared projects: projects the current user is a member of
const { data: members } = await supabase
  .from('project_members')
  .select('project_id')
  .or(`user_id.eq.${userId}`);

if (members && members.length > 0) {
  const ids = members.map((m: any) => m.project_id);
  const { data: shared } = await supabase
    .from('projects')
    .select('*')
    .in('id', ids);
}
```

### RLS Enforcement
- User A creates project → RLS allows A to SELECT/UPDATE/DELETE
- User A invites User B → INSERT into project_members
- User B: SELECT respects RLS subquery check of project_members
- User B can UPDATE if role='editor', cannot if role='viewer'

### Badge on Landing Page
```typescript
{sharedProjectIds.has(project.id) && (
  <span style={{ ... }}>shared</span>
)}
```

---

## 11. Object Model

The object model is **identical to the desktop version**:

```typescript
interface CanvasObject {
  id: number;                                    // Unique in project
  type: 'image' | 'text' | 'shape' | 'drawing' | 'markup' | 'swatch';
  x: number;
  y: number;
  w: number;
  h: number;
  zIndex: number;

  // image
  content?: string;                              // Supabase Storage path
  crop?: { x: number; y: number; w: number; h: number }; // % of image

  // text
  textStyle?: 'title' | 'subtitle' | 'description';

  // drawing
  points?: { x: number; y: number }[];
  strokeColor?: string;
  strokeWidth?: number;

  // markup (cloud + leader)
  cloud?: { rx: number; ry: number; rw: number; rh: number };
  leader?: { tx: number; ty: number };
  markupText?: string;

  // swatch
  // content stores hex color
}
```

### Object Defaults
```typescript
const OBJ_DEFAULTS = {
  id: 0, type: 'image', x: 0, y: 0, w: 200, h: 150,
  content: '', zIndex: 1, textStyle: 'title',
  crop: null, points: null, strokeColor: '#F0C4A0', strokeWidth: 4,
  cloud: null, leader: null, markupText: '',
};
```

### Storage in Supabase
Objects stored as JSONB array in `projects.objects`:
```sql
UPDATE projects SET objects = '[
  {
    "id": 1,
    "type": "image",
    "x": 100,
    "y": 200,
    "w": 300,
    "h": 200,
    "content": "d4a3f1e9-2c0b-4f13-a2bb-5e1d9c3f7a2e/1710965432189.jpg",
    "zIndex": 1
  },
  ...
]'::jsonb;
```

---

## 12. How to Add a New Feature

### Add a New Tool

**Example: "Highlight" tool (yellow rectangle)**

**1. Add to activeTool enum:**
```typescript
let activeTool: 'pointer' | 'rect' | 'markup' | 'draw' | 'eyedropper' | 'highlight' = 'pointer';
```

**2. Add tool button to canvas.tsx JSX:**
```tsx
<button className="tool-btn" data-tool="highlight" title="Highlight (H)">
  <svg>...</svg>
</button>
```

**3. Add setTool logic in setTool():**
```typescript
function setTool(tool: 'pointer' | 'rect' | 'markup' | 'draw' | 'eyedropper' | 'highlight') {
  activeTool = tool;
  // ... existing code ...
  if (tool === 'highlight') {
    document.querySelector('[data-tool="highlight"]')?.classList.add('active');
    viewport.classList.add('drawing');
  }
}
```

**4. Add click listener:**
```typescript
document.querySelector('[data-tool="highlight"]')?.addEventListener('click', () =>
  setTool(activeTool === 'highlight' ? 'pointer' : 'highlight')
);
```

**5. Add keyboard shortcut:**
```typescript
if (e.key === 'h' && !e.ctrlKey && !e.metaKey && !inEdit)
  setTool(activeTool === 'highlight' ? 'pointer' : 'highlight');
```

**6. Add mousedown handler in viewport:**
```typescript
viewport.addEventListener('mousedown', (e: MouseEvent) => {
  if (e.button !== 0 || activeTool !== 'highlight' || spaceDown) return;
  if ((e.target as HTMLElement).closest('.resize-handle')) return;
  e.preventDefault(); e.stopPropagation();
  selectObject(null);

  const sw = screenToWorld(e.clientX, e.clientY);
  // ... draw preview rectangle ...

  function onUp(ev: MouseEvent) {
    // ... create highlight object ...
    pushUndo();
    const id = nextId++;
    const mz = objects.length ? Math.max(...objects.map(o => o.zIndex)) + 1 : 1;
    objects.push(normalizeObject({
      id, type: 'shape',
      x: Math.min(sw.x, ew.x), y: Math.min(sw.y, ew.y),
      w: rw, h: rh,
      content: '#ffff00', // Store color as content
      zIndex: mz,
    }));
    selectObject(id); renderObjects(); markDirty();
  }
  // ... attach listeners ...
}, true);
```

**7. Add renderObjects() case:**
```typescript
} else if (obj.type === 'shape') {
  el.classList.add('shape-obj');
  el.style.background = obj.content || 'var(--peach)';
}
```

**8. Add CSS:**
```css
.shape-obj {
  border: 2px solid rgba(255,255,255,0.2);
  background: var(--peach);
}
```

### Add a New API Route

**Example: `/api/projects` to list all projects**

**1. Create file:**
```
src/app/api/projects/route.ts
```

**2. Implement:**
```typescript
import { createClient } from '@/lib/supabase-server';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('owner_id', user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
```

**3. Call from client:**
```typescript
const res = await fetch('/api/projects');
const projects = await res.json();
```

### Modify Database Schema

**Example: Add `description` field to projects**

**1. Create migration:**
```sql
ALTER TABLE projects ADD COLUMN description TEXT DEFAULT '';
```

**2. Update types (database.ts):**
```typescript
Row: {
  id: string;
  description: string;  // NEW
  // ... rest ...
};
```

**3. Update Supabase local schema file:**
Edit `supabase-schema.sql` to include new column in CREATE TABLE comment.

**4. Redeploy:**
```bash
supabase db push  # If using local Supabase
# OR manually run SQL in Supabase dashboard
```

---

## 13. Deployment

### Local Development
```bash
npm install
npm run dev
# Open http://localhost:3000
```

### Deploy to Vercel
```bash
# Set env vars in Vercel dashboard:
# NEXT_PUBLIC_SUPABASE_URL
# NEXT_PUBLIC_SUPABASE_ANON_KEY
# SUPABASE_SERVICE_ROLE_KEY

git push origin main
# Vercel auto-deploys
```

### Build & Start
```bash
npm run build   # Compiles Next.js
npm start       # Runs production server
```

---

## 14. Differences from Desktop Version

### Storage
- **Desktop**: File system (`~/.sketchbook/projects/...`)
- **Web**: Supabase Storage (cloud, publicly accessible URLs)

### Image Paths
- **Desktop**: `file://C:/Users/.../image.jpg`
- **Web**: `https://supabase.../storage/v1/object/public/project-assets/.../image.jpg`
- **Web requires**: `crossOrigin="anonymous"` for eyedropper to work

### Clipboard
- **Desktop**: Electron clipboard API (`clipboard.readImage()`)
- **Web**: `navigator.clipboard.read()` with `image/*` type filtering
- **Web constraint**: Only works on HTTPS in production

### Image Compression
- **Desktop**: Sharp library (Node.js, lossless)
- **Web**: Canvas API (browser, lossy JPEG 0.85-0.9 quality)
- **Web constraint**: No access to server-side image libraries

### Persistence
- **Desktop**: Saved to disk automatically, manual export to PNG/PDF
- **Web**: Auto-saves every 500ms to Supabase, versioning via `updated_at` timestamp

### Collaboration
- **Desktop**: None (single user)
- **Web**: Real-time sync via Supabase Realtime + project sharing via email

### Keyboard Shortcuts
- **Desktop**: Some shortcuts use Electron APIs (e.g., Cmd+H to hide)
- **Web**: Pure browser events, no Electron APIs

---

## 15. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **r** | Toggle Rectangle tool |
| **m** | Toggle Markup (cloud + leader) tool |
| **d** | Toggle Draw tool |
| **i** | Toggle Eyedropper (color picker) tool |
| **v** | Pointer tool |
| **f** | Fit selection/all objects to view |
| **a** | Select all |
| **Delete** / **Backspace** | Delete selected |
| **Escape** | Deselect, close menus, exit tool |
| **Ctrl+Z** / **Cmd+Z** | Undo |
| **Ctrl+Y** / **Cmd+Y** | Redo |
| **Ctrl+Shift+Z** / **Cmd+Shift+Z** | Redo |
| **Ctrl+S** / **Cmd+S** | Save project |
| **Ctrl+V** / **Cmd+V** | Paste image from clipboard |
| **Space** | Hold to pan (grab mode) |
| **Ctrl+Right-Click + Drag** | Zoom (drag up to zoom out) |
| **Right-Click** | Pan or show context menu |
| **Middle-Click** | Pan |
| **Shift+Click** | Add to selection |
| **Alt+Click+Drag** | Duplicate selection |
| **Double-Click** (text) | Edit text in-place |
| **Double-Click** (image) | Open inline crop |
| **Mouse Wheel** | Zoom in/out |

---

## 16. Common Tasks

### Debug Realtime Not Syncing
1. Open Supabase dashboard → Realtime logs
2. Check that `lastSaveTime` guard isn't blocking (2-second window)
3. Verify RLS policies allow SELECT on projects table
4. Check browser console for `[realtime]` logs

### Invite Not Sending
1. Verify `SUPABASE_SERVICE_ROLE_KEY` is set in API route
2. Check that project owner is inviting (RLS check)
3. Verify user email is valid
4. Check Supabase Auth → Email Templates (might be disabled)
5. Invited user should receive magic link within 1 minute

### Image Upload Fails
1. Check file size (images > 2MB are resized)
2. Verify `project-assets` bucket exists and is public
3. Check storage policies allow authenticated uploads
4. Check browser console for CORS errors
5. Verify NEXT_PUBLIC_SUPABASE_URL is correct

### Save Not Working
1. Check that user is authenticated: `supabase.auth.getSession()`
2. Verify RLS policy allows UPDATE on projects
3. Check project ownership: `owner_id = auth.uid()`
4. If shared project, check `project_members` role='editor'
5. Look for save errors in console: `[canvas] save error:`

---

## 17. Project Structure
```
sketchbook online/
├── src/
│   ├── app/
│   │   ├── layout.tsx              # Root layout
│   │   ├── page.tsx                # Landing / project list
│   │   ├── page.module.css         # Landing styles
│   │   ├── canvas/
│   │   │   ├── page.tsx            # Canvas workspace (2200+ lines)
│   │   │   ├── canvas.css          # Canvas styles (579 lines)
│   │   │   └── page.module.css     # Module styles
│   │   ├── auth/
│   │   │   └── callback/
│   │   │       └── route.ts        # OAuth callback
│   │   └── api/
│   │       └── invite/
│   │           └── route.ts        # Invite API
│   ├── lib/
│   │   ├── supabase-browser.ts     # Browser client
│   │   └── supabase-server.ts      # Server client
│   ├── types/
│   │   └── database.ts             # TypeScript types
│   └── middleware.ts               # Auth refresh
├── supabase-schema.sql             # Database schema
├── package.json
├── tsconfig.json
├── next.config.js
└── .env.local                      # Local env (not in git)
```

---

## 18. Testing

### Test Auth Flow
1. Click "Sign in with Google"
2. Use test Google account
3. Check that session cookie is set (DevTools → Application → Cookies)
4. Verify landing page shows projects

### Test Canvas Engine
1. Create project
2. Add image (drag or paste)
3. Add text, shapes, markups, drawings
4. Undo/redo
5. Check that objects persist on page reload

### Test Sharing
1. Create project, click "Share"
2. Invite yourself with another email (or colleague)
3. Check that invited user receives email
4. Sign in as invited user, verify can access project
5. Edit canvas, verify other user sees changes in real-time

### Test Realtime Sync
1. Open project in two tabs
2. Edit objects in tab A
3. Verify tab B auto-updates within 2 seconds
4. Check that pan/zoom stays independent per tab

---

## 19. Performance Notes

### Render Performance
- Object rendering is `O(n)` for n objects
- For 100+ objects, consider spatial indexing
- Undo/redo copies entire objects array (deep serialize) — limit MAX_UNDO to 80

### Save Performance
- 500ms debounce prevents spamming Supabase
- Each save uploads full `objects` array (no delta sync)
- For large projects (1000+ objects), consider splitting into multiple tables

### Storage Performance
- Images auto-resized to max 1200px on client
- JPEG quality set to 0.85-0.9 (good balance)
- Consider CDN caching for frequently-accessed images

### Real-time Latency
- Supabase Realtime uses WebSocket (sub-second)
- 2-second `lastSaveTime` guard is conservative
- Could reduce to 500ms if false negatives are acceptable

---

## 20. Security Considerations

### RLS is Enforced
- All queries go through `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public key)
- RLS policies enforce row-level access
- Users cannot query other users' projects without being invited

### Service Role Key
- Only used in API route (server-side)
- Bypasses RLS (needed for sending invites)
- **NEVER expose in client code**

### CORS & Cross-Origin
- `crossOrigin="anonymous"` allows eyedropper to read image pixels
- Requires CORS headers from Supabase Storage (default)
- If custom image storage, ensure CORS is configured

### Session Security
- httpOnly cookies prevent XSS attacks
- Secure flag ensures HTTPS-only in production
- Refresh token rotation via middleware on every request

---

## 21. Resources

- [Next.js 14 Docs](https://nextjs.org/docs)
- [Supabase Docs](https://supabase.com/docs)
- [Supabase Auth with Next.js](https://supabase.com/docs/guides/auth/auth-with-nextjs)
- [Supabase Realtime](https://supabase.com/docs/guides/realtime)
- [Row Level Security](https://supabase.com/docs/guides/auth/row-level-security)

---

**Last Updated**: March 2026
**Maintainer**: [Your Name]
