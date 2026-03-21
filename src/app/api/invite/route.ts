import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { projectId, email } = await request.json();
    if (!projectId || !email) {
      return NextResponse.json({ error: 'Missing projectId or email' }, { status: 400 });
    }

    // Verify the requesting user owns the project
    const supabaseUser = await createServerClient();
    const { data: { user } } = await supabaseUser.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Check project ownership
    const { data: project } = await supabaseUser
      .from('projects')
      .select('id, name, owner_id')
      .eq('id', projectId)
      .eq('owner_id', user.id)
      .single();

    if (!project) {
      return NextResponse.json({ error: 'Project not found or not owned by you' }, { status: 403 });
    }

    // Use service role client for admin operations
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Add to project_members
    const { error: memberError } = await supabaseAdmin
      .from('project_members')
      .upsert({
        project_id: projectId,
        email: email.toLowerCase().trim(),
        role: 'editor',
      }, { onConflict: 'project_id,email' });

    if (memberError) {
      return NextResponse.json({ error: memberError.message }, { status: 500 });
    }

    // Invite user via Supabase Auth (sends them a magic link email)
    // If user already exists, this is a no-op on the auth side but the member row is what matters
    const { error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      email.toLowerCase().trim(),
      {
        redirectTo: `${request.headers.get('origin') || process.env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/canvas?project=${projectId}`,
      }
    );

    // Ignore "user already registered" error — that's fine
    if (inviteError && !inviteError.message.includes('already been registered')) {
      console.error('Invite error:', inviteError.message);
      // Still return success since the member row was created
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Invite API error:', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
