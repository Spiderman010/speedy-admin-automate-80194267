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
      app_settings: {
        Row: {
          id: string
          key: string
          updated_at: string
          user_id: string
          value: Json
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string
          user_id: string
          value?: Json
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string
          user_id?: string
          value?: Json
        }
        Relationships: []
      }
      bank_transactions: {
        Row: {
          amount: number
          client_id: string
          counter_account: string | null
          created_at: string
          description: string | null
          grootboekrekening_id: string | null
          id: string
          ledger_account_id: string | null
          match_confidence: number | null
          match_status: string
          matched_invoice_id: string | null
          reference: string | null
          transaction_date: string
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          client_id: string
          counter_account?: string | null
          created_at?: string
          description?: string | null
          grootboekrekening_id?: string | null
          id?: string
          ledger_account_id?: string | null
          match_confidence?: number | null
          match_status?: string
          matched_invoice_id?: string | null
          reference?: string | null
          transaction_date: string
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          client_id?: string
          counter_account?: string | null
          created_at?: string
          description?: string | null
          grootboekrekening_id?: string | null
          id?: string
          ledger_account_id?: string | null
          match_confidence?: number | null
          match_status?: string
          matched_invoice_id?: string | null
          reference?: string | null
          transaction_date?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_transactions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_grootboekrekening_id_fkey"
            columns: ["grootboekrekening_id"]
            isOneToOne: false
            referencedRelation: "grootboekrekeningen"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_ledger_account_id_fkey"
            columns: ["ledger_account_id"]
            isOneToOne: false
            referencedRelation: "ledger_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_tx_grootboek_backup_20260420: {
        Row: {
          grootboekrekening_id: string | null
          id: string | null
        }
        Insert: {
          grootboekrekening_id?: string | null
          id?: string | null
        }
        Update: {
          grootboekrekening_id?: string | null
          id?: string | null
        }
        Relationships: []
      }
      booking_templates: {
        Row: {
          actie: string | null
          actief: boolean | null
          btw_percentage: number | null
          client_id: string | null
          client_id_filter: string | null
          created_at: string
          default_amount: number | null
          description: string | null
          geldt_voor: string | null
          id: string
          ledger_account_id: string | null
          ledger_account_text: string | null
          name: string
          prioriteit: number | null
          user_id: string
          zoek_in: string | null
          zoekterm: string | null
        }
        Insert: {
          actie?: string | null
          actief?: boolean | null
          btw_percentage?: number | null
          client_id?: string | null
          client_id_filter?: string | null
          created_at?: string
          default_amount?: number | null
          description?: string | null
          geldt_voor?: string | null
          id?: string
          ledger_account_id?: string | null
          ledger_account_text?: string | null
          name: string
          prioriteit?: number | null
          user_id: string
          zoek_in?: string | null
          zoekterm?: string | null
        }
        Update: {
          actie?: string | null
          actief?: boolean | null
          btw_percentage?: number | null
          client_id?: string | null
          client_id_filter?: string | null
          created_at?: string
          default_amount?: number | null
          description?: string | null
          geldt_voor?: string | null
          id?: string
          ledger_account_id?: string | null
          ledger_account_text?: string | null
          name?: string
          prioriteit?: number | null
          user_id?: string
          zoek_in?: string | null
          zoekterm?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "booking_templates_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_templates_ledger_account_id_fkey"
            columns: ["ledger_account_id"]
            isOneToOne: false
            referencedRelation: "ledger_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          address: string | null
          afgesloten_boekjaar: number | null
          bank_dagboek: number | null
          btw_number: string | null
          btw_type: string
          btw_vrijgesteld: boolean
          city: string | null
          contact_person: string | null
          country: string
          created_at: string
          email: string | null
          ibans: string[] | null
          id: string
          inkoop_dagboek: number | null
          kvk_number: string | null
          name: string
          phone: string | null
          postal_code: string | null
          rechtsvorm: string | null
          updated_at: string
          user_id: string
          verkoop_dagboek: number | null
          verwerkingsfrequentie: string | null
        }
        Insert: {
          address?: string | null
          afgesloten_boekjaar?: number | null
          bank_dagboek?: number | null
          btw_number?: string | null
          btw_type?: string
          btw_vrijgesteld?: boolean
          city?: string | null
          contact_person?: string | null
          country?: string
          created_at?: string
          email?: string | null
          ibans?: string[] | null
          id?: string
          inkoop_dagboek?: number | null
          kvk_number?: string | null
          name: string
          phone?: string | null
          postal_code?: string | null
          rechtsvorm?: string | null
          updated_at?: string
          user_id: string
          verkoop_dagboek?: number | null
          verwerkingsfrequentie?: string | null
        }
        Update: {
          address?: string | null
          afgesloten_boekjaar?: number | null
          bank_dagboek?: number | null
          btw_number?: string | null
          btw_type?: string
          btw_vrijgesteld?: boolean
          city?: string | null
          contact_person?: string | null
          country?: string
          created_at?: string
          email?: string | null
          ibans?: string[] | null
          id?: string
          inkoop_dagboek?: number | null
          kvk_number?: string | null
          name?: string
          phone?: string | null
          postal_code?: string | null
          rechtsvorm?: string | null
          updated_at?: string
          user_id?: string
          verkoop_dagboek?: number | null
          verwerkingsfrequentie?: string | null
        }
        Relationships: []
      }
      grootboekrekeningen: {
        Row: {
          actief: boolean
          categorie: string
          client_id: string | null
          created_at: string
          id: string
          nummer: number
          omschrijving: string
          updated_at: string
          user_id: string
        }
        Insert: {
          actief?: boolean
          categorie?: string
          client_id?: string | null
          created_at?: string
          id?: string
          nummer: number
          omschrijving: string
          updated_at?: string
          user_id: string
        }
        Update: {
          actief?: boolean
          categorie?: string
          client_id?: string | null
          created_at?: string
          id?: string
          nummer?: number
          omschrijving?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      grootboekrekeningen_backup_20260420: {
        Row: {
          actief: boolean | null
          categorie: string | null
          client_id: string | null
          created_at: string | null
          id: string | null
          nummer: number | null
          omschrijving: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          actief?: boolean | null
          categorie?: string | null
          client_id?: string | null
          created_at?: string | null
          id?: string | null
          nummer?: number | null
          omschrijving?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          actief?: boolean | null
          categorie?: string | null
          client_id?: string | null
          created_at?: string | null
          id?: string | null
          nummer?: number | null
          omschrijving?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      journal_entries: {
        Row: {
          amount: number
          btw_amount: number | null
          btw_percentage: number | null
          client_id: string
          created_at: string
          description: string | null
          entry_date: string
          entry_type: string
          id: string
          invoice_number: string | null
          ledger_account_id: string | null
          ledger_account_text: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          btw_amount?: number | null
          btw_percentage?: number | null
          client_id: string
          created_at?: string
          description?: string | null
          entry_date: string
          entry_type?: string
          id?: string
          invoice_number?: string | null
          ledger_account_id?: string | null
          ledger_account_text?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          btw_amount?: number | null
          btw_percentage?: number | null
          client_id?: string
          created_at?: string
          description?: string | null
          entry_date?: string
          entry_type?: string
          id?: string
          invoice_number?: string | null
          ledger_account_id?: string | null
          ledger_account_text?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "journal_entries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_ledger_account_id_fkey"
            columns: ["ledger_account_id"]
            isOneToOne: false
            referencedRelation: "ledger_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_accounts: {
        Row: {
          category: string | null
          client_id: string
          code: string
          created_at: string
          id: string
          name: string
          user_id: string
        }
        Insert: {
          category?: string | null
          client_id: string
          code: string
          created_at?: string
          id?: string
          name: string
          user_id: string
        }
        Update: {
          category?: string | null
          client_id?: string
          code?: string
          created_at?: string
          id?: string
          name?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ledger_accounts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_invoice_lines: {
        Row: {
          amount_excl: number
          btw_percentage: number | null
          created_at: string
          grootboekrekening_id: string | null
          id: string
          omschrijving: string
          purchase_invoice_id: string
          sort_order: number
          user_id: string
        }
        Insert: {
          amount_excl: number
          btw_percentage?: number | null
          created_at?: string
          grootboekrekening_id?: string | null
          id?: string
          omschrijving: string
          purchase_invoice_id: string
          sort_order?: number
          user_id: string
        }
        Update: {
          amount_excl?: number
          btw_percentage?: number | null
          created_at?: string
          grootboekrekening_id?: string | null
          id?: string
          omschrijving?: string
          purchase_invoice_id?: string
          sort_order?: number
          user_id?: string
        }
        Relationships: []
      }
      purchase_invoices: {
        Row: {
          amount_excl: number | null
          amount_incl: number | null
          btw_amount: number | null
          btw_percentage: number | null
          client_id: string
          created_at: string
          document_route: string
          file_path: string | null
          grootboekrekening_id: string | null
          id: string
          invoice_date: string | null
          invoice_number: string | null
          ledger_account_id: string | null
          ledger_account_text: string | null
          notes: string | null
          ocr_data: Json | null
          original_ubl_path: string | null
          remaining_amount: number | null
          route_reason: string | null
          status: string
          supplier: string
          supplier_btw_number: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount_excl?: number | null
          amount_incl?: number | null
          btw_amount?: number | null
          btw_percentage?: number | null
          client_id: string
          created_at?: string
          document_route?: string
          file_path?: string | null
          grootboekrekening_id?: string | null
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          ledger_account_id?: string | null
          ledger_account_text?: string | null
          notes?: string | null
          ocr_data?: Json | null
          original_ubl_path?: string | null
          remaining_amount?: number | null
          route_reason?: string | null
          status?: string
          supplier: string
          supplier_btw_number?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount_excl?: number | null
          amount_incl?: number | null
          btw_amount?: number | null
          btw_percentage?: number | null
          client_id?: string
          created_at?: string
          document_route?: string
          file_path?: string | null
          grootboekrekening_id?: string | null
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          ledger_account_id?: string | null
          ledger_account_text?: string | null
          notes?: string | null
          ocr_data?: Json | null
          original_ubl_path?: string | null
          remaining_amount?: number | null
          route_reason?: string | null
          status?: string
          supplier?: string
          supplier_btw_number?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_invoices_grootboekrekening_id_fkey"
            columns: ["grootboekrekening_id"]
            isOneToOne: false
            referencedRelation: "grootboekrekeningen"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_invoices_ledger_account_id_fkey"
            columns: ["ledger_account_id"]
            isOneToOne: false
            referencedRelation: "ledger_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_invoices: {
        Row: {
          amount_excl: number | null
          amount_incl: number | null
          btw_amount: number | null
          btw_percentage: number | null
          btw_verlegd: boolean
          client_id: string
          created_at: string
          customer_name: string
          due_date: string | null
          id: string
          invoice_date: string
          invoice_number: string
          ledger_account_text: string | null
          notes: string | null
          pdf_path: string | null
          remaining_amount: number | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          amount_excl?: number | null
          amount_incl?: number | null
          btw_amount?: number | null
          btw_percentage?: number | null
          btw_verlegd?: boolean
          client_id: string
          created_at?: string
          customer_name: string
          due_date?: string | null
          id?: string
          invoice_date: string
          invoice_number: string
          ledger_account_text?: string | null
          notes?: string | null
          pdf_path?: string | null
          remaining_amount?: number | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          amount_excl?: number | null
          amount_incl?: number | null
          btw_amount?: number | null
          btw_percentage?: number | null
          btw_verlegd?: boolean
          client_id?: string
          created_at?: string
          customer_name?: string
          due_date?: string | null
          id?: string
          invoice_date?: string
          invoice_number?: string
          ledger_account_text?: string | null
          notes?: string | null
          pdf_path?: string | null
          remaining_amount?: number | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sales_invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      vraagposten: {
        Row: {
          categorie: string
          client_id: string | null
          created_at: string
          id: string
          omschrijving: string | null
          resolved_at: string | null
          source_id: string | null
          source_type: string
          status: string
          titel: string
          updated_at: string
          user_id: string
        }
        Insert: {
          categorie: string
          client_id?: string | null
          created_at?: string
          id?: string
          omschrijving?: string | null
          resolved_at?: string | null
          source_id?: string | null
          source_type: string
          status?: string
          titel: string
          updated_at?: string
          user_id: string
        }
        Update: {
          categorie?: string
          client_id?: string | null
          created_at?: string
          id?: string
          omschrijving?: string | null
          resolved_at?: string | null
          source_id?: string | null
          source_type?: string
          status?: string
          titel?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
