export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      message_reactions: {
        Row: {
          created_at: string;
          emoji: string;
          id: string;
          message_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          emoji: string;
          id?: string;
          message_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          emoji?: string;
          id?: string;
          message_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_reactions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          attachment_meta: Json | null;
          attachment_url: string | null;
          body: string | null;
          created_at: string;
          deleted_at: string | null;
          edited_at: string | null;
          id: string;
          parent_id: string | null;
          pinned: boolean;
          recipient_count: number | null;
          room_id: string;
          type: Database["public"]["Enums"]["message_type"];
          user_id: string;
          // Audit-2 M2: the callId of a type:'call' entry (one entry
          // per callId, partial unique index in §M2 SQL). NULL for
          // every other message type.
          call_id: string | null;
          // Audit-3 A4-N4: client-side idempotency key for a send
          // (outbox entry id / fresh UUID per composer send). Unique
          // index in §A4-N4 SQL. NULL for legacy rows and sends
          // without a key (no dedupe).
          client_id: string | null;
        };
        Insert: {
          attachment_meta?: Json | null;
          attachment_url?: string | null;
          body?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          edited_at?: string | null;
          id?: string;
          parent_id?: string | null;
          pinned?: boolean;
          recipient_count?: number | null;
          room_id: string;
          type?: Database["public"]["Enums"]["message_type"];
          user_id: string;
          call_id?: string | null;
          // Audit-3 A4-N4: client-side idempotency key (see Row).
          client_id?: string | null;
        };
        Update: {
          attachment_meta?: Json | null;
          attachment_url?: string | null;
          body?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          edited_at?: string | null;
          id?: string;
          parent_id?: string | null;
          pinned?: boolean;
          recipient_count?: number | null;
          room_id?: string;
          type?: Database["public"]["Enums"]["message_type"];
          user_id?: string;
          call_id?: string | null;
          // Audit-3 A4-N4: client-side idempotency key (see Row).
          client_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "messages_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          banned: boolean;
          bio: string | null;
          created_at: string;
          custom_status: string | null;
          display_name: string;
          e2e_public_key: string | null;
          id: string;
          is_avatar_public: boolean;
          is_bio_public: boolean;
          is_name_public: boolean;
          is_online: boolean;
          is_public: boolean;
          is_status_public: boolean;
          show_notification_previews: boolean;
          last_seen_at: string;
          message_count: number;
          muted_until: string | null;
        };
        Insert: {
          avatar_url?: string | null;
          banned?: boolean;
          bio?: string | null;
          created_at?: string;
          custom_status?: string | null;
          display_name?: string;
          e2e_public_key?: string | null;
          id: string;
          is_avatar_public?: boolean;
          is_bio_public?: boolean;
          is_name_public?: boolean;
          is_online?: boolean;
          is_public?: boolean;
          is_status_public?: boolean;
          show_notification_previews?: boolean;
          last_seen_at?: string;
          message_count?: number;
          muted_until?: string | null;
        };
        Update: {
          avatar_url?: string | null;
          banned?: boolean;
          bio?: string | null;
          created_at?: string;
          custom_status?: string | null;
          display_name?: string;
          e2e_public_key?: string | null;
          id?: string;
          is_avatar_public?: boolean;
          is_bio_public?: boolean;
          is_name_public?: boolean;
          is_online?: boolean;
          is_public?: boolean;
          is_status_public?: boolean;
          show_notification_previews?: boolean;
          last_seen_at?: string;
          message_count?: number;
          muted_until?: string | null;
        };
        Relationships: [];
      };
      // Audit-2 C3: privacy-filtered view over profiles (SECURITY
      // DEFINER). Hand-added (H23 pattern) — the generator predates it.
      // Read-only for the app: only Row is ever selected.
      profiles_public: {
        Row: {
          id: string;
          display_name: string;
          avatar_url: string | null;
          bio: string | null;
          custom_status: string | null;
          is_public: boolean;
          is_online: boolean | null;
          last_seen_at: string | null;
        };
        Insert: {
          id?: string;
          display_name?: string;
          avatar_url?: string | null;
          bio?: string | null;
          custom_status?: string | null;
          is_public?: boolean;
          is_online?: boolean | null;
          last_seen_at?: string | null;
        };
        Update: {
          id?: string;
          display_name?: string;
          avatar_url?: string | null;
          bio?: string | null;
          custom_status?: string | null;
          is_public?: boolean;
          is_online?: boolean | null;
          last_seen_at?: string | null;
        };
        Relationships: [];
      };
      room_members: {
        Row: {
          joined_at: string;
          room_id: string;
          user_id: string;
          pinned_at: string | null;
          is_muted: boolean;
        };
        Insert: {
          joined_at?: string;
          room_id: string;
          user_id: string;
          pinned_at?: string | null;
          is_muted?: boolean;
        };
        Update: {
          joined_at?: string;
          room_id?: string;
          user_id?: string;
          pinned_at?: string | null;
          is_muted?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "room_members_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      rooms: {
        Row: {
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          is_dm: boolean;
          is_e2ee: boolean;
          is_private: boolean;
          last_activity_at: string;
          name: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_dm?: boolean;
          is_e2ee?: boolean;
          is_private?: boolean;
          last_activity_at?: string;
          name: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_dm?: boolean;
          is_e2ee?: boolean;
          is_private?: boolean;
          last_activity_at?: string;
          name?: string;
        };
        Relationships: [];
      };
      tokens: {
        Row: {
          code: string;
          created_at: string;
          created_by: string | null;
          expires_at: string | null;
          id: string;
          label: string | null;
          revoked: boolean;
          used_at: string | null;
          used_by: string | null;
        };
        Insert: {
          code: string;
          created_at?: string;
          created_by?: string | null;
          expires_at?: string | null;
          id?: string;
          label?: string | null;
          revoked?: boolean;
          used_at?: string | null;
          used_by?: string | null;
        };
        Update: {
          code?: string;
          created_at?: string;
          created_by?: string | null;
          expires_at?: string | null;
          id?: string;
          label?: string | null;
          revoked?: boolean;
          used_at?: string | null;
          used_by?: string | null;
        };
        Relationships: [];
      };
      // Audit-4 C1: server-side password-setup-pending state (see
      // supabase/vibetalk-audit4-fixes.sql §C1). Service-role only.
      password_setup_pending: {
        Row: {
          created_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      typing_status: {
        Row: {
          room_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          room_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          room_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "typing_status_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      push_subscriptions: {
        Row: {
          id: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          endpoint?: string;
          p256dh?: string;
          auth?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      read_receipts: {
        Row: {
          room_id: string;
          user_id: string;
          last_read_at: string;
        };
        Insert: {
          room_id: string;
          user_id: string;
          last_read_at?: string;
        };
        Update: {
          room_id?: string;
          user_id?: string;
          last_read_at?: string;
        };
        Relationships: [];
      };
      // H23: added to match vibetalk-all-pending.sql §2 (calls) + §5
      // (call_invites). The generated types predated these tables, so
      // every query on them type-checked as a SelectQueryError union.
      // type/direction/status are TEXT with CHECK constraints in SQL
      // (not enums), so they are plain strings here.
      calls: {
        Row: {
          id: string;
          user_id: string;
          peer_id: string;
          peer_name: string;
          type: string;
          direction: string;
          status: string;
          duration_seconds: number;
          started_at: string;
          ended_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          peer_id: string;
          peer_name?: string;
          type: string;
          direction: string;
          status: string;
          duration_seconds?: number;
          started_at?: string;
          ended_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          peer_id?: string;
          peer_name?: string;
          type?: string;
          direction?: string;
          status?: string;
          duration_seconds?: number;
          started_at?: string;
          ended_at?: string | null;
        };
        Relationships: [];
      };
      call_invites: {
        Row: {
          id: string;
          caller_id: string;
          callee_id: string;
          caller_name: string;
          type: string;
          status: string;
          created_at: string;
          // Audit-2 C1: per-call HMAC secret (NULL on pre-§C1 rows).
          secret: string | null;
        };
        Insert: {
          id: string;
          caller_id: string;
          callee_id: string;
          caller_name?: string;
          type: string;
          status?: string;
          created_at?: string;
          secret?: string | null;
        };
        Update: {
          id?: string;
          caller_id?: string;
          callee_id?: string;
          caller_name?: string;
          type?: string;
          status?: string;
          created_at?: string;
          secret?: string | null;
        };
        Relationships: [];
      };
      // Audit-2 M53: live presence (heartbeat writes here, never
      // `profiles`, so it no longer broadcasts on Realtime).
      // Hand-added (this file is otherwise generated).
      presence: {
        Row: {
          user_id: string;
          last_seen_at: string;
        };
        Insert: {
          user_id: string;
          last_seen_at?: string;
        };
        Update: {
          user_id?: string;
          last_seen_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "presence_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      // Audit-2 H4: per-IP rate-limit buckets (audit2-fixes §H4).
      // Hand-added (this file is otherwise generated).
      rate_limits: {
        Row: {
          key: string;
          window_start: string;
          count: number;
        };
        Insert: {
          key: string;
          window_start: string;
          count?: number;
        };
        Update: {
          key?: string;
          window_start?: string;
          count?: number;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      can_view_room: {
        Args: { _room_id: string; _user_id: string };
        Returns: boolean;
      };
      get_thread_previews: {
        Args: { p_room_ids: string[] };
        Returns: {
          room_id: string;
          user_id: string;
          body: string | null;
          type: string;
          created_at: string;
          display_name: string;
        }[];
      };
      get_or_create_dm: { Args: { _other: string }; Returns: string };
      // Audit-2 H4: atomic per-IP rate-limit check (audit2-fixes §H4).
      check_rate_limit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number };
        Returns: boolean;
      };
      // M105: create_room_with_creator RPC (audit-fixes §M105).
      create_room_with_creator: {
        Args: {
          _name: string;
          _description: string | null;
          _is_private: boolean;
          _is_e2ee: boolean;
        };
        Returns: string;
      };
      is_room_member: {
        Args: { _room_id: string; _user_id: string };
        Returns: boolean;
      };
      // Audit-5 B3-MEDIUM: orphan-attachment finder (audit4-fixes §A5-M4).
      find_orphan_attachments: {
        Args: { _limit: number };
        Returns: string[];
      };
      touch_presence: { Args: never; Returns: undefined };
      // Audit-3 A4-N25: atomic public-room join (audit3-fixes §A4-N25).
      join_public_room: { Args: { _room_id: string }; Returns: undefined };
      // Audit-3 A4-N30: atomic leave — returns whether the room was deleted (audit3-fixes §A4-N30).
      leave_room_atomic: { Args: { _room_id: string }; Returns: boolean };
      get_unread_counts: {
        Args: Record<string, never>;
        Returns: { room_id: string; unread_count: number }[];
      };
    };
    Enums: {
      message_type: "text" | "image" | "video" | "audio" | "voice" | "file" | "system" | "call";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      // Audit-4 L66: "call" was missing here while the Enums
      // type above includes it — Constants must mirror Enums.
      message_type: ["text", "image", "video", "audio", "voice", "file", "system", "call"],
    },
  },
} as const;
