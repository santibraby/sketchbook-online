export type Database = {
  public: {
    Tables: {
      projects: {
        Row: {
          id: string;
          name: string;
          owner_id: string;
          canvas_state: {
            panX: number;
            panY: number;
            zoom: number;
          } | null;
          objects: any[] | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          owner_id: string;
          canvas_state?: {
            panX: number;
            panY: number;
            zoom: number;
          } | null;
          objects?: any[] | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          owner_id?: string;
          canvas_state?: {
            panX: number;
            panY: number;
            zoom: number;
          } | null;
          objects?: any[] | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      project_members: {
        Row: {
          id: string;
          project_id: string;
          user_id: string | null;
          email: string;
          role: string;
          invited_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          user_id?: string | null;
          email: string;
          role?: string;
          invited_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          user_id?: string | null;
          email?: string;
          role?: string;
          invited_at?: string;
        };
      };
    };
    Views: {};
    Functions: {};
    Enums: {};
    CompositeTypes: {};
  };
};
