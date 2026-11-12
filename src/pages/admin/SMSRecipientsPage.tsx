import { useEffect, useMemo, useState } from "react";
import {
  Users,
  Phone,
  CheckCircle,
  XCircle,
  Loader2,
  Shield,
  Edit,
  Mail,
  MessageCircle,
} from "lucide-react";
import { Badge, Input, Select, SelectContent, SelectItem, Table, TableHeader, TableRow, TableCell, Pagination } from "../../ui";
import { useSupabase } from "../../lib/supabase";
import type { UserRole } from "../../types";

interface AlertRecipientForm {
  name: string;
  phone_number: string;
  role: "admin" | "maintenance" | "security";
  room_ids: string[];
}

interface SMSRecipientsPageProps {
  userRole: "admin" | "maintenance" | "security";
}

export default function SMSRecipientsPage({ userRole }: SMSRecipientsPageProps) {
  const { supabase, error: supaError } = useSupabase();
  const [recipients, setRecipients] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editRecipient, setEditRecipient] = useState<any | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [confirmDelete, setConfirmDelete] = useState<{ id: number; show: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  // Simplified room IDs handling - stored as comma-separated string in the form
  const [roomIdsInput, setRoomIdsInput] = useState("");

  const canManage = userRole === "admin";

  useEffect(() => {
    if (supaError) console.error("Supabase error:", supaError);
    supabase
      .from("alert_recipients")
      .select("*")
      .eq("active", true)
      .order("name", { ascending: true })
      .then(({ data, error }) => {
        if (error) console.error("Failed to fetch recipients:", error.message);
        else setRecipients(data ?? []);
      });
  }, [supaError]);

  const filtered = useMemo(() => {
    if (!search.trim()) return recipients;
    const q = search.toLowerCase();
    return recipients.filter(
      (r) => r.name.toLowerCase().includes(q) || r.phone_number.toLowerCase().includes(q) || (r.role ?? "").toLowerCase().includes(q)
    );
  }, [recipients, search]);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / 10));

  const paginated = useMemo(() => {
    const start = (page - 1) * 10;
    const end = start + 10;
    return filtered.slice(start, end);
  }, [filtered, page]);

  function handleAdd() {
    setEditRecipient(null);
    setRoomIdsInput("");
    setShowForm(true);
  }

  function handleEdit(recipient: any) {
    // Pre-fill the room IDs input from the stored array
    const ids = recipient.room_ids ?? [];
    setEditRecipient({ ...recipient, room_ids: ids });
    setRoomIdsInput(ids.join(","));
    setShowForm(true);
  }

  function handleDelete(id: number) {
    setConfirmDelete({ id, show: true });
  }

  async function doDelete(id: number) {
    const { error } = await supabase
      .from("alert_recipients")
      .update({ active: false })
      .eq("id", id);
    if (error) console.error("Failed to delete recipient:", error.message);
    else setConfirmDelete(null);
  }

  async function handleSendTestSMS() {
    if (!canManage) return;
    setSending(true);

    // Call the edge function with a fake danger reading
    try {
      const testRoomIds = [];
      const res = await supabase.functions
        .rpc("send_sms_alert", {
          device_id: "TEST-001",
          co2: 400,
          lpg: 4500, // Critical LPG
          temp: 30,
          humidity: 50,
          created_at: new Date().toISOString(),
        })
        .then(() => {
          console.log("Test SMS RPC initiated");
        })
        .catch((err) => {
          console.error("Test SMS RPC failed:", err);
        });
      alert(`Test SMS triggered. Check the console. Recipients: ${total}`);
    } catch (e) {
      console.error("Error triggering test SMS:", e);
      alert("Failed to trigger test SMS. Check the console for details.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between gap-3 mb-5">
        <h1 className="text-xl font-semibold text-slate-900">SMS Alert Recipients</h1>
        {canManage && (
          <button
            onClick={() => handleAdd()}
            style={{
              background: "#0d9488",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "10px 16px",
              fontSize: 13,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 6,
              cursor: "pointer",
            }}
          >
            <Users size={15} /> Add Recipient
          </button>
        )}
        {canManage && (
          <button
            onClick={() => handleSendTestSMS()}
            style={{
              background: "#d97706",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "10px 16px",
              fontSize: 13,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 6,
              cursor: "pointer",
            }}
            disabled={recipients.length === 0}
          >
            <MessageCircle size={15} /> Send Test SMS
          </button>
        )}
      </div>

      {canManage && (
        <div className="mb-4">
          <Input
            placeholder="Search recipients (name, phone, role)..."
            value={search}
            onValueChange={(v) => setSearch(v)}
            style={{ width: "300px" }}
          />
        </div>
      )}

      {supaError && <p className="text-red-600">Supabase error: {supaError.message}</p>}

      {/* Recipients table */}
      {paginated.length > 0 || !supaError ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell style={{ width: "140px" }}>Phone Number</TableCell>
              <TableCell style={{ width: "100px" }}>Role</TableCell>
              <TableCell style={{ width: "100px" }}>Rooms</TableCell>
              <TableCell style={{ width: "80px" }}>Active</TableCell>
              {canManage && <TableCell />}
            </TableRow>
          </TableHeader>

          {paginated.map((r, i) => (
            <TableRow key={r.id} style={{ borderBottom: "1px solid #e2e8f0" }}>
              <TableCell>{r.name}</TableCell>
              <TableCell>{r.phone_number}</TableCell>
              <TableCell>
                <Badge
                  label={r.role}
                  tone={
                    r.role === "admin"
                      ? "danger"
                      : r.role === "maintenance"
                      ? "warning"
                      : "success"
                  }
                />
              </TableCell>
              <TableCell>
                {r.room_ids && r.room_ids.length > 0
                  ? r.room_ids.map((rid: string) => `<span key={rid} className="text-xs">${rid}</span>`).join(", ")
                  : "All rooms"}
              </TableCell>
              <TableCell>
                {r.active ? (
                  <Badge label="Active" tone="success" />
                ) : (
                  <Badge label="Inactive" tone="warning" />
                )}
              </TableCell>
              {canManage && (
                <TableCell>
                  <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
                    {r.active ? (
                      <>
                        <button
                          onClick={() => handleEdit(r)}
                          style={{
                            fontSize: 10,
                            color: "#0891b2",
                            background: "transparent",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                          }}
                        >
                          <Edit size={14} />
                        </button>
                        <button
                          onClick={() => handleDelete(r.id)}
                          style={{
                            fontSize: 10,
                            color: "#dc2626",
                            background: "transparent",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => handleEdit(r)}
                        style={{
                          fontSize: 10,
                          color: "#dc2626",
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                        }}
                        >
                          <Edit size={14} />
                        </button>
                      )}
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))}

          {paginated.length < total && !supaError && (
            <TableRow>
              <TableCell colSpan={7}>
                <Pagination
                  currentPage={page}
                  totalPages={totalPages}
                  onChange={(newPage: number) => setPage(newPage)}
                />
              </TableCell>
            </TableRow>
          )}
        </Table>
      ) : (
        <p className="text-slate-500">No recipients found. Add a new recipient above.</p>
      )}

      {/* Add/Edit Recipient Modal */}
      {showForm && editRecipient !== null && (
        <div style={{ position: "fixed", left: 0, top: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", padding: 24, borderRadius: 12, width: 520, maxHeight: "80vh", overflowY: "auto" }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>
              {editRecipient.id ? "Edit Recipient" : "Add New Recipient"}
            </h2>
            <form
              onSubmit={(e: any) => {
                e.preventDefault();
                const form: AlertRecipientForm = {
                  name: e.target.name.value,
                  phone_number: e.target.phone_number.value,
                  role: e.target.role.value,
                  // room_ids parsed from the comma-separated input
                  room_ids: roomIdsInput.split(",").map((s: string) => s.trim()).filter(Boolean) ?? [],
                };
                if (editRecipient.id) {
                  supabase
                    .from("alert_recipients")
                    .update({ name: form.name, phone_number: form.phone_number, role: form.role, room_ids: form.room_ids, active: editRecipient.active })
                    .eq("id", editRecipient.id);
                } else {
                  supabase
                    .from("alert_recipients")
                    .insert({ name: form.name, phone_number: form.phone_number, role: form.role, room_ids: form.room_ids, active: true });
                }
                setShowForm(false);
              }}
            >
              <Input
                name="name"
                placeholder="Recipient name"
                defaultValue={editRecipient?.name ?? ""}
                style={{ width: "100%", marginBottom: 12, padding: 8, borderRadius: 6, border: "1px solid #e2e8f0" }}
                required
              />
              <Input
                name="phone_number"
                placeholder="Phone number (e.g. 09171234567)"
                type="tel"
                defaultValue={editRecipient?.phone_number ?? ""}
                style={{ width: "100%", marginBottom: 12, padding: 8, borderRadius: 6, border: "1px solid #e2e8f0" }}
                required
              />
              <Select
                defaultValue={editRecipient?.role ?? "admin"}
                style={{ width: "100%", marginBottom: 12, marginTop: 4 }}
              >
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="maintenance">Maintenance</SelectItem>
                <SelectItem value="security">Security</SelectItem>
              </Select>
              <div>
                <label style={{ display: "block", fontSize: 12, color: "#334155", marginBottom: 6, marginTop: 12 }}>Covered Rooms</label>
                <Input
                  name="room_ids"
                  placeholder="Comma-separated room IDs (or leave empty for all rooms)"
                  defaultValue={roomIdsInput}
                  style={{ width: "100%", marginBottom: 12, padding: 8, borderRadius: 6, border: "1px solid #e2e8f0" }}
                />
                <small style={{ color: "#64748b", fontSize: 11 }}>
                  Leave empty to notify all rooms.
                </small>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 24 }}>
                <button type="button" onClick={() => setShowForm(false)} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", color: "#334155" }}>Cancel</button>
                <button type="submit" style={{ padding: "8px 16px", borderRadius: 6, background: canManage ? "#0d9488" : "#94a3b8", color: "#fff", border: "none", fontWeight: 700 }}>
                  {editRecipient.id ? "Update" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirmDelete && confirmDelete.show && (
        <div style={{
          position: "fixed", left: 0, top: 0, right: 0, bottom: 0,
          background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{ background: "#fff", padding: 24, borderRadius: 12, maxWidth: 400 }}>
            <p style={{ margin: "12px 0", fontSize: 14 }}>Are you sure you want to delete this recipient?</p>
            <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
              <button onClick={() => setConfirmDelete(null)} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", color: "#334155" }}>Cancel</button>
              <button
                onClick={() => { doDelete(confirmDelete.id); setConfirmDelete(null); }}
                style={{
                  padding: "8px 16px", borderRadius: 6, background: "#dc2626", color: "#fff", border: "none", fontWeight: 700,
                }}
                >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}