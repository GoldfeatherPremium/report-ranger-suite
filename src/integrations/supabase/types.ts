export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          entity: string | null
          entity_id: string | null
          id: string
          metadata: Json | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          metadata?: Json | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          metadata?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          attempts: number
          bull_job_id: string | null
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          last_polled_at: string | null
          max_attempts: number
          mime_type: string | null
          original_name: string
          portal_id: string | null
          queued_at: string | null
          size_bytes: number | null
          slot_id: string | null
          source_path: string
          started_at: string | null
          status: Database["public"]["Enums"]["job_state"]
          turnitin_submission_id: string | null
          updated_at: string
          user_id: string
          worker_id: string | null
        }
        Insert: {
          attempts?: number
          bull_job_id?: string | null
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          last_polled_at?: string | null
          max_attempts?: number
          mime_type?: string | null
          original_name: string
          portal_id?: string | null
          queued_at?: string | null
          size_bytes?: number | null
          slot_id?: string | null
          source_path: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_state"]
          turnitin_submission_id?: string | null
          updated_at?: string
          user_id: string
          worker_id?: string | null
        }
        Update: {
          attempts?: number
          bull_job_id?: string | null
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          last_polled_at?: string | null
          max_attempts?: number
          mime_type?: string | null
          original_name?: string
          portal_id?: string | null
          queued_at?: string | null
          size_bytes?: number | null
          slot_id?: string | null
          source_path?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_state"]
          turnitin_submission_id?: string | null
          updated_at?: string
          user_id?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_portal_id_fkey"
            columns: ["portal_id"]
            isOneToOne: false
            referencedRelation: "portal_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "turnitin_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_configs: {
        Row: {
          base_url: string
          created_at: string
          id: string
          is_active: boolean
          login_config: Json | null
          name: string
          poll_interval_ms: number
          selectors: Json
          timeout_ms: number
          updated_at: string
        }
        Insert: {
          base_url: string
          created_at?: string
          id?: string
          is_active?: boolean
          login_config?: Json | null
          name: string
          poll_interval_ms?: number
          selectors?: Json
          timeout_ms?: number
          updated_at?: string
        }
        Update: {
          base_url?: string
          created_at?: string
          id?: string
          is_active?: boolean
          login_config?: Json | null
          name?: string
          poll_interval_ms?: number
          selectors?: Json
          timeout_ms?: number
          updated_at?: string
        }
        Relationships: []
      }
      reports: {
        Row: {
          created_at: string
          file_name: string
          id: string
          job_id: string
          mime_type: string | null
          size_bytes: number | null
          storage_path: string
        }
        Insert: {
          created_at?: string
          file_name: string
          id?: string
          job_id: string
          mime_type?: string | null
          size_bytes?: number | null
          storage_path: string
        }
        Update: {
          created_at?: string
          file_name?: string
          id?: string
          job_id?: string
          mime_type?: string | null
          size_bytes?: number | null
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      turnitin_accounts: {
        Row: {
          created_at: string
          email: string
          id: string
          is_active: boolean
          label: string
          login_url: string
          notes: string | null
          password_encrypted: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          is_active?: boolean
          label: string
          login_url?: string
          notes?: string | null
          password_encrypted: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          is_active?: boolean
          label?: string
          login_url?: string
          notes?: string | null
          password_encrypted?: string
          updated_at?: string
        }
        Relationships: []
      }
      turnitin_slot_usage: {
        Row: {
          freed_at: string | null
          id: string
          job_id: string
          slot_id: string
          submitted_at: string
          turnitin_submission_id: string | null
        }
        Insert: {
          freed_at?: string | null
          id?: string
          job_id: string
          slot_id: string
          submitted_at?: string
          turnitin_submission_id?: string | null
        }
        Update: {
          freed_at?: string | null
          id?: string
          job_id?: string
          slot_id?: string
          submitted_at?: string
          turnitin_submission_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "turnitin_slot_usage_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "turnitin_slots"
            referencedColumns: ["id"]
          },
        ]
      }
      turnitin_slots: {
        Row: {
          account_id: string
          cooldown_hours: number
          created_at: string
          id: string
          is_active: boolean
          label: string
          submit_url: string | null
          updated_at: string
        }
        Insert: {
          account_id: string
          cooldown_hours?: number
          created_at?: string
          id?: string
          is_active?: boolean
          label: string
          submit_url?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          cooldown_hours?: number
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          submit_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "turnitin_slots_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "turnitin_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          id: string
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: []
      }
      worker_health: {
        Row: {
          active_jobs: number
          last_seen: string
          status: string
          worker_id: string
        }
        Insert: {
          active_jobs?: number
          last_seen?: string
          status?: string
          worker_id: string
        }
        Update: {
          active_jobs?: number
          last_seen?: string
          status?: string
          worker_id?: string
        }
        Relationships: []
      }
      worker_logs: {
        Row: {
          created_at: string
          id: string
          job_id: string | null
          level: string
          message: string
          metadata: Json | null
          worker_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          job_id?: string | null
          level?: string
          message: string
          metadata?: Json | null
          worker_id: string
        }
        Update: {
          created_at?: string
          id?: string
          job_id?: string | null
          level?: string
          message?: string
          metadata?: Json | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_logs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _turnitin_key: { Args: never; Returns: string }
      add_turnitin_account: {
        Args: {
          p_email: string
          p_label: string
          p_login_url: string
          p_notes: string
          p_password: string
        }
        Returns: string
      }
      claim_next_job: {
        Args: { p_worker_id: string }
        Returns: {
          attempts: number
          bull_job_id: string | null
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          last_polled_at: string | null
          max_attempts: number
          mime_type: string | null
          original_name: string
          portal_id: string | null
          queued_at: string | null
          size_bytes: number | null
          slot_id: string | null
          source_path: string
          started_at: string | null
          status: Database["public"]["Enums"]["job_state"]
          turnitin_submission_id: string | null
          updated_at: string
          user_id: string
          worker_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      decrypt_account_password: { Args: { account: string }; Returns: string }
      encrypt_account_password: { Args: { plain: string }; Returns: string }
      is_admin: { Args: never; Returns: boolean }
      requeue_stuck_jobs: {
        Args: { p_max_age_minutes?: number }
        Returns: number
      }
    }
    Enums: {
      job_state:
        | "pending"
        | "queued"
        | "processing"
        | "completed"
        | "failed"
        | "cancelled"
      user_role: "user" | "admin"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      job_state: [
        "pending",
        "queued",
        "processing",
        "completed",
        "failed",
        "cancelled",
      ],
      user_role: ["user", "admin"],
    },
  },
} as const
