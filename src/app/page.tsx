'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import type { User } from '@supabase/supabase-js';
import styles from './page.module.css';

interface Project {
  id: string;
  name: string;
  owner_id: string;
  canvas_state: any;
  objects: any;
  created_at: string;
  updated_at: string;
}

export default function Home() {
  const router = useRouter();
  const supabase = createClient();

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sharedProjects, setSharedProjects] = useState<Project[]>([]);
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);

  // ── Auth + Load Projects ──
  useEffect(() => {
    async function init() {
      try {
        // Check session first (faster than getUser)
        const { data: { session } } = await supabase.auth.getSession();
        console.log('[init] session:', session ? `user=${session.user.email}` : 'none');

        if (session?.user) {
          setUser(session.user);
          await fetchProjects(session.user.id);
        }
      } catch (err) {
        console.error('[init] error:', err);
      } finally {
        setLoading(false);
      }
    }

    init();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        console.log('[auth] state change:', _event, session?.user?.email);
        const newUser = session?.user || null;
        setUser(newUser);
        setLoading(false);
        if (newUser) {
          fetchProjects(newUser.id);
        } else {
          setProjects([]);
          setSharedProjects([]);
        }
      }
    );

    return () => subscription?.unsubscribe();
  }, []);

  // ── Fetch Projects ──
  async function fetchProjects(userId: string) {
    console.log('[fetchProjects] for user:', userId);
    try {
      // Own projects
      const { data: owned, error: ownedErr } = await supabase
        .from('projects')
        .select('*')
        .eq('owner_id', userId)
        .order('updated_at', { ascending: false });

      console.log('[fetchProjects] owned:', owned?.length, 'error:', ownedErr?.message);
      setProjects(owned || []);

      // Shared projects
      const { data: members, error: membersErr } = await supabase
        .from('project_members')
        .select('project_id')
        .or(`user_id.eq.${userId}`);

      console.log('[fetchProjects] memberships:', members?.length, 'error:', membersErr?.message);

      if (members && members.length > 0) {
        const ids = members.map((m: any) => m.project_id);
        const { data: shared } = await supabase
          .from('projects')
          .select('*')
          .in('id', ids)
          .order('updated_at', { ascending: false });
        setSharedProjects(shared || []);
      } else {
        setSharedProjects([]);
      }
    } catch (err) {
      console.error('[fetchProjects] error:', err);
    }
  }

  // ── Sign In ──
  async function handleSignIn() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + '/auth/callback',
      },
    });
    if (error) console.error('[signIn] error:', error);
  }

  // ── Sign Out ──
  async function handleSignOut() {
    console.log('[signOut] signing out...');
    const { error } = await supabase.auth.signOut();
    console.log('[signOut] result:', error?.message || 'success');
    if (!error) {
      setUser(null);
      setProjects([]);
      setSharedProjects([]);
    }
  }

  // ── Create Project ──
  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newProjectName.trim() || !user) return;

    setCreatingProject(true);
    console.log('[createProject] starting for user:', user.id, 'name:', newProjectName.trim());

    try {
      // First verify we have a valid session
      const { data: { session } } = await supabase.auth.getSession();
      console.log('[createProject] session check:', session ? 'valid' : 'MISSING');

      if (!session) {
        alert('Session expired. Please sign in again.');
        setCreatingProject(false);
        return;
      }

      // Insert with explicit timeout handling
      const insertPromise = supabase
        .from('projects')
        .insert({
          name: newProjectName.trim(),
          owner_id: user.id,
          canvas_state: { panX: 0, panY: 0, zoom: 1 },
          objects: [],
        })
        .select()
        .single();

      // Race against a timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Insert timed out after 10s')), 10000)
      );

      const { data: newProject, error } = await Promise.race([insertPromise, timeoutPromise]) as any;

      console.log('[createProject] result:', { newProject, error: error?.message });

      if (error) {
        alert('Error: ' + error.message);
        return;
      }

      if (!newProject) {
        alert('No data returned. RLS may be blocking the insert. Check Supabase RLS policies.');
        return;
      }

      setNewProjectName('');
      setProjects([newProject, ...projects]);
      router.push(`/canvas?project=${newProject.id}`);
    } catch (err: any) {
      console.error('[createProject] error:', err);
      alert('Error: ' + (err?.message || 'Unknown error'));
    } finally {
      setCreatingProject(false);
    }
  }

  // ── Delete Project ──
  async function handleDeleteProject(projectId: string) {
    if (!user) return;
    if (!confirm('Delete this project?')) return;

    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', projectId)
      .eq('owner_id', user.id);

    if (error) {
      console.error('[delete] error:', error);
    } else {
      setProjects(projects.filter((p) => p.id !== projectId));
    }
  }

  // ── Format Date ──
  function formatDate(dateString: string) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ── Loading ──
  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loadingSpinner}>Loading...</div>
      </div>
    );
  }

  // ── Not signed in ──
  if (!user) {
    return (
      <div className={styles.container}>
        <div className={styles.signInCard}>
          <h1 className={styles.title}>Sketchbook</h1>
          <p className={styles.subtitle}>Drop images, add text, build boards.</p>
          <button className="btn" onClick={handleSignIn}>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  // ── Signed in ──
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.userInfo}>
          <img
            src={user.user_metadata?.avatar_url || ''}
            alt=""
            className={styles.avatar}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
          <span className={styles.email}>{user.email}</span>
        </div>
        <button className="btn-ghost" onClick={handleSignOut}>
          Sign out
        </button>
      </div>

      <div className={styles.content}>
        <form className={styles.createForm} onSubmit={handleCreateProject}>
          <input
            type="text"
            placeholder="New project name..."
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            maxLength={100}
          />
          <button type="submit" className="btn" disabled={creatingProject || !newProjectName.trim()}>
            {creatingProject ? 'Creating...' : 'Create'}
          </button>
        </form>

        {projects.length > 0 && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Recent Projects</h2>
            <div className={styles.projectGrid}>
              {projects.map((project) => (
                <div key={project.id} className={styles.projectCard}>
                  <div
                    className={styles.projectContent}
                    onClick={() => router.push(`/canvas?project=${project.id}`)}
                  >
                    <h3 className={styles.projectName}>{project.name}</h3>
                    <p className={styles.projectDate}>{formatDate(project.updated_at)}</p>
                  </div>
                  <button
                    className="btn-icon"
                    onClick={(e) => { e.stopPropagation(); handleDeleteProject(project.id); }}
                    title="Delete project"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {sharedProjects.length > 0 && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Shared with me</h2>
            <div className={styles.projectGrid}>
              {sharedProjects.map((project) => (
                <div key={project.id} className={styles.projectCard}>
                  <div
                    className={styles.projectContent}
                    onClick={() => router.push(`/canvas?project=${project.id}`)}
                  >
                    <h3 className={styles.projectName}>{project.name}</h3>
                    <p className={styles.projectDate}>{formatDate(project.updated_at)}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {projects.length === 0 && sharedProjects.length === 0 && (
          <div className={styles.emptyState}>
            <p>No projects yet. Create one to get started!</p>
          </div>
        )}
      </div>
    </div>
  );
}
