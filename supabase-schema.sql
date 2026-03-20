-- Sketchbook App Schema
-- PostgreSQL/Supabase SQL schema for collaborative canvas-based sketching application

-- =====================================================================
-- ENABLE EXTENSIONS
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================================
-- TABLES
-- =====================================================================

-- Projects: Main canvas projects created by users
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  canvas_state JSONB DEFAULT '{"panX":0,"panY":0,"zoom":1}'::jsonb,
  objects JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Project Members: Sharing permissions for collaborative editing
CREATE TABLE project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT DEFAULT 'editor',
  invited_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, email)
);

-- =====================================================================
-- INDEXES
-- =====================================================================

CREATE INDEX idx_projects_owner_id ON projects(owner_id);
CREATE INDEX idx_project_members_project_id ON project_members(project_id);
CREATE INDEX idx_project_members_user_id ON project_members(user_id);
CREATE INDEX idx_project_members_email ON project_members(email);

-- =====================================================================
-- AUTO-UPDATE FUNCTION FOR updated_at
-- =====================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at on projects table
DROP TRIGGER IF EXISTS projects_update_updated_at ON projects;
CREATE TRIGGER projects_update_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================================

-- Enable RLS on both tables
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- PROJECTS RLS POLICIES
-- =====================================================================

-- Policy: Users can INSERT their own projects (set owner_id to current user)
CREATE POLICY projects_insert_own ON projects
  FOR INSERT
  WITH CHECK (owner_id = auth.uid());

-- Policy: Users can SELECT their own projects OR projects shared with them
CREATE POLICY projects_select_own_or_shared ON projects
  FOR SELECT
  USING (
    owner_id = auth.uid()
    OR id IN (
      SELECT project_id FROM project_members
      WHERE (user_id = auth.uid() OR email = auth.jwt() ->> 'email')
    )
  );

-- Policy: Users can UPDATE their own projects OR projects where they are a member (editor role)
CREATE POLICY projects_update_own_or_shared ON projects
  FOR UPDATE
  USING (
    owner_id = auth.uid()
    OR id IN (
      SELECT project_id FROM project_members
      WHERE (user_id = auth.uid() OR email = auth.jwt() ->> 'email')
        AND role = 'editor'
    )
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR id IN (
      SELECT project_id FROM project_members
      WHERE (user_id = auth.uid() OR email = auth.jwt() ->> 'email')
        AND role = 'editor'
    )
  );

-- Policy: Users can DELETE only their own projects (owners only)
CREATE POLICY projects_delete_own ON projects
  FOR DELETE
  USING (owner_id = auth.uid());

-- =====================================================================
-- PROJECT_MEMBERS RLS POLICIES
-- =====================================================================

-- Policy: Project owners can INSERT members (invite users)
CREATE POLICY project_members_insert_owner ON project_members
  FOR INSERT
  WITH CHECK (
    project_id IN (
      SELECT id FROM projects WHERE owner_id = auth.uid()
    )
  );

-- Policy: Project owners can DELETE members (remove invites/access)
CREATE POLICY project_members_delete_owner ON project_members
  FOR DELETE
  USING (
    project_id IN (
      SELECT id FROM projects WHERE owner_id = auth.uid()
    )
  );

-- Policy: Members can SELECT their own memberships
CREATE POLICY project_members_select_own ON project_members
  FOR SELECT
  USING (
    user_id = auth.uid()
    OR email = auth.jwt() ->> 'email'
  );

-- =====================================================================
-- STORAGE & BUCKETS
-- =====================================================================

-- NOTE: Storage buckets and policies must be created via Supabase dashboard or CLI
--
-- To create the "project-assets" bucket, run:
--
-- 1. Via Supabase Dashboard:
--    - Go to Storage > Buckets
--    - Create a new bucket named "project-assets"
--    - Make it Public (public read access)
--
-- 2. Then add this storage policy via SQL:
--
--    CREATE POLICY "Authenticated users can upload to project-assets"
--    ON storage.objects
--    FOR INSERT
--    WITH CHECK (
--      bucket_id = 'project-assets'
--      AND auth.role() = 'authenticated'
--    );
--
--    CREATE POLICY "Authenticated users can read from project-assets"
--    ON storage.objects
--    FOR SELECT
--    USING (bucket_id = 'project-assets');
--
--    CREATE POLICY "Authenticated users can update their own files in project-assets"
--    ON storage.objects
--    FOR UPDATE
--    USING (bucket_id = 'project-assets' AND auth.uid() = owner)
--    WITH CHECK (bucket_id = 'project-assets' AND auth.uid() = owner);
--
--    CREATE POLICY "Authenticated users can delete their own files in project-assets"
--    ON storage.objects
--    FOR DELETE
--    USING (bucket_id = 'project-assets' AND auth.uid() = owner);

-- =====================================================================
-- COMMENTS FOR DOCUMENTATION
-- =====================================================================

COMMENT ON TABLE projects IS 'Canvas projects created by users. Each project contains canvas state and serialized objects.';
COMMENT ON TABLE project_members IS 'Project sharing and collaboration. Tracks invitations by email and member access roles.';

COMMENT ON COLUMN projects.canvas_state IS 'JSON object storing canvas viewport state: {panX, panY, zoom}';
COMMENT ON COLUMN projects.objects IS 'JSON array of canvas objects: images, text, shapes, markups, drawings, swatches, etc.';
COMMENT ON COLUMN project_members.role IS 'Member role: "editor" (read/write) or "viewer" (read-only)';
COMMENT ON COLUMN project_members.email IS 'Email of invited user, allows matching when they sign up';
