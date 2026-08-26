import { useEffect, useState, type FormEvent } from "react";
import { UserPlus, Shield, Wrench, Crown, Ban, RotateCcw, Loader2, X, Pencil, Trash2 } from "lucide-react";
import { supabase } from "../../lib/supabase";

interface Personnel {
  id: string;
  email: string;
  name: string;
  role: string;
  role_label: string;
  department: string | null;
  contact_number: string | null;
  access_scope: string | null;
  is_active: boolean;
  created_at: string;
}

const ROLE_OPTIONS = [
  { value: "admin", label: "Administrator" },
  { value: "security", label: "Security Personnel" },
  { value: "maintenance", label: "Maintenance Personnel" },
];

function RoleIcon({ role }: { role: string }) {
  if (role === "admin") return <Crown className="w-3 h-3" />;
  if (role === "security") return <Shield className="w-3 h-3" />;
  return <Wrench className="w-3 h-3" />;
}

export default function PersonnelManagementPage() {
  const [personnel, setPersonnel] = useState<Personnel[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "security",
    department: "",
    contact_number: "",
  });

  // --- Edit state ---
  const [editingPerson, setEditingPerson] = useState<Personnel | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    email: "",
    role: "security",
    department: "",
    contact_number: "",
  });
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // --- Delete state ---
  const [deletingPerson, setDeletingPerson] = useState<Personnel | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function loadPersonnel() {
    setLoading(true);
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .in("role", ["admin", "security", "maintenance"])
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Failed to load personnel:", error.message);
    } else {
      setPersonnel((data as Personnel[]) ?? []);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadPersonnel();
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null);
    });
  }, []);

  // Active admins right now — used to block removing the last one.
  const activeAdminCount = personnel.filter((p) => p.role === "admin" && p.is_active).length;

  // Delete/Deactivate must stay blocked for: yourself, or the last remaining active admin.
  function getLockReason(person: Personnel): string | null {
    if (person.id === currentUserId) {
      return "You can't remove your own admin access.";
    }
    if (person.role === "admin" && person.is_active && activeAdminCount <= 1) {
      return "At least one active admin must remain.";
    }
    return null;
  }

  async function handleAddPersonnel(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!form.name || !form.email || !form.password) {
      setFormError("Name, email, and password are required.");
      return;
    }
    if (form.password.length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }

    setSubmitting(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      setFormError("Your session expired. Please log in again.");
      setSubmitting(false);
      return;
    }

    const roleLabel = ROLE_OPTIONS.find((r) => r.value === form.role)?.label ?? form.role;

    const { data, error } = await supabase.functions.invoke("admin-create-personnel", {
      body: {
        email: form.email,
        password: form.password,
        name: form.name,
        role: form.role,
        role_label: roleLabel,
        department: form.department || null,
        contact_number: form.contact_number || null,
      },
    });

    setSubmitting(false);

    if (error || data?.error) {
      setFormError(data?.error ?? error?.message ?? "Failed to create personnel account.");
      return;
    }

    setForm({ name: "", email: "", password: "", role: "security", department: "", contact_number: "" });
    setShowAddForm(false);
    loadPersonnel();
  }

  async function toggleActive(person: Personnel) {
    setTogglingId(person.id);

    const updates = { is_active: !person.is_active };
    const { error } = await (supabase.from("profiles") as any)
      .update(updates)
      .eq("id", person.id);

    setTogglingId(null);

    if (error) {
      console.error("Failed to update status:", error.message);
      return;
    }

    setPersonnel((prev) =>
      prev.map((p) => (p.id === person.id ? { ...p, is_active: !p.is_active } : p))
    );
  }

  // --- Edit handlers ---
  function openEditForm(person: Personnel) {
    setEditingPerson(person);
    setEditError(null);
    setEditForm({
      name: person.name,
      email: person.email,
      role: person.role,
      department: person.department ?? "",
      contact_number: person.contact_number ?? "",
    });
  }

  function closeEditForm() {
    setEditingPerson(null);
    setEditError(null);
  }

  async function handleEditPersonnel(e: FormEvent) {
    e.preventDefault();
    if (!editingPerson) return;
    setEditError(null);

    if (!editForm.name || !editForm.email) {
      setEditError("Name and email are required.");
      return;
    }

    setEditSubmitting(true);

    const roleLabel = ROLE_OPTIONS.find((r) => r.value === editForm.role)?.label ?? editForm.role;

    const updates = {
      name: editForm.name,
      email: editForm.email,
      role: editForm.role,
      role_label: roleLabel,
      department: editForm.department || null,
      contact_number: editForm.contact_number || null,
    };

    const { error } = await (supabase.from("profiles") as any)
      .update(updates)
      .eq("id", editingPerson.id);

    setEditSubmitting(false);

    if (error) {
      setEditError(error.message ?? "Failed to update personnel.");
      return;
    }

    setPersonnel((prev) =>
      prev.map((p) => (p.id === editingPerson.id ? { ...p, ...updates } : p))
    );
    closeEditForm();
  }

  // --- Delete handlers ---
  function openDeleteConfirm(person: Personnel) {
    setDeletingPerson(person);
    setDeleteError(null);
  }

  function closeDeleteConfirm() {
    setDeletingPerson(null);
    setDeleteError(null);
  }

  async function handleDeletePersonnel() {
    if (!deletingPerson) return;
    setDeleteSubmitting(true);
    setDeleteError(null);

    const { error } = await supabase
      .from("profiles")
      .delete()
      .eq("id", deletingPerson.id);

    setDeleteSubmitting(false);

    if (error) {
      setDeleteError(error.message ?? "Failed to delete personnel.");
      return;
    }

    setPersonnel((prev) => prev.filter((p) => p.id !== deletingPerson.id));
    setDeletingPerson(null);
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Personnel Management</h1>
          <p className="text-sm text-slate-500 mt-1">
            Manage admin, security, and maintenance staff access.
          </p>
        </div>
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors w-full sm:w-auto"
        >
          <UserPlus className="w-4 h-4" />
          Add Personnel
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading personnel...
        </div>
      ) : personnel.length === 0 ? (
        <div className="text-center py-16 text-slate-400 text-sm">
          No admin, security, or maintenance personnel added yet.
        </div>
      ) : (
        <>
          {/* Mobile: stacked cards, shown below md */}
          <div className="md:hidden space-y-3">
            {personnel.map((person) => (
              <div
                key={person.id}
                className="bg-white rounded-xl border border-slate-200 p-4"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800 truncate">{person.name}</p>
                    <p className="text-xs text-slate-500 truncate">{person.email}</p>
                  </div>
                  <span
                    className={`shrink-0 text-xs font-medium px-2 py-1 rounded-md ${
                      person.is_active
                        ? "bg-teal-50 text-teal-700"
                        : "bg-red-50 text-red-600"
                    }`}
                  >
                    {person.is_active ? "Active" : "Deactivated"}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 mb-3">
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-md bg-slate-100 text-slate-700">
                    <RoleIcon role={person.role} />
                    {person.role_label}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs mb-3">
                  <div>
                    <span className="text-slate-400">Department</span>
                    <p className="text-slate-600">{person.department ?? "—"}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">Contact No.</span>
                    <p className="text-slate-600">{person.contact_number ?? "—"}</p>
                  </div>
                </div>

                {(() => {
                  const lockReason = getLockReason(person);
                  // Only the Deactivate action is locked — Reactivate never reduces admin coverage.
                  const deactivateLocked = person.is_active && !!lockReason;
                  const deleteLocked = !!lockReason;
                  return (
                    <>
                      {lockReason && (
                        <p className="text-[11px] text-amber-600 mb-2">{lockReason}</p>
                      )}
                      <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                        <button
                          onClick={() => openEditForm(person)}
                          className="flex-1 inline-flex items-center justify-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          Edit
                        </button>
                        <button
                          onClick={() => toggleActive(person)}
                          disabled={togglingId === person.id || deactivateLocked}
                          title={deactivateLocked ? lockReason ?? undefined : undefined}
                          className={`flex-1 inline-flex items-center justify-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border transition-colors disabled:opacity-50 ${
                            person.is_active
                              ? "border-red-200 text-red-600 hover:bg-red-50"
                              : "border-teal-200 text-teal-700 hover:bg-teal-50"
                          }`}
                        >
                          {togglingId === person.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : person.is_active ? (
                            <Ban className="w-3.5 h-3.5" />
                          ) : (
                            <RotateCcw className="w-3.5 h-3.5" />
                          )}
                          {person.is_active ? "Deactivate" : "Reactivate"}
                        </button>
                        <button
                          onClick={() => openDeleteConfirm(person)}
                          disabled={deleteLocked}
                          title={deleteLocked ? lockReason ?? undefined : undefined}
                          className="inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-lg border border-slate-200 text-slate-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-slate-500 disabled:hover:border-slate-200"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
            ))}
          </div>

          {/* Desktop: table, shown from md up */}
          <div className="hidden md:block bg-white rounded-xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs font-medium text-slate-500 tracking-wide">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Department</th>
                  <th className="px-4 py-3">Contact No.</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right w-32">Actions</th>
                </tr>
              </thead>
              <tbody>
                {personnel.map((person) => (
                  <tr key={person.id} className="border-b border-slate-50 last:border-0">
                    <td className="px-4 py-3 font-medium text-slate-800">{person.name}</td>
                    <td className="px-4 py-3 text-slate-500">{person.email}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-md bg-slate-100 text-slate-700">
                        <RoleIcon role={person.role} />
                        {person.role_label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{person.department ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-500">{person.contact_number ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs font-medium px-2 py-1 rounded-md ${
                          person.is_active
                            ? "bg-teal-50 text-teal-700"
                            : "bg-red-50 text-red-600"
                        }`}
                      >
                        {person.is_active ? "Active" : "Deactivated"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const lockReason = getLockReason(person);
                        const deactivateLocked = person.is_active && !!lockReason;
                        const deleteLocked = !!lockReason;
                        return (
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => openEditForm(person)}
                              title="Edit"
                              className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => toggleActive(person)}
                              disabled={togglingId === person.id || deactivateLocked}
                              title={
                                deactivateLocked
                                  ? lockReason ?? undefined
                                  : person.is_active
                                  ? "Deactivate"
                                  : "Reactivate"
                              }
                              className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border transition-colors disabled:opacity-50 ${
                                person.is_active
                                  ? "border-red-200 text-red-600 hover:bg-red-50"
                                  : "border-teal-200 text-teal-700 hover:bg-teal-50"
                              }`}
                            >
                              {togglingId === person.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : person.is_active ? (
                                <Ban className="w-3.5 h-3.5" />
                              ) : (
                                <RotateCcw className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <button
                              onClick={() => openDeleteConfirm(person)}
                              disabled={deleteLocked}
                              title={deleteLocked ? lockReason ?? undefined : "Delete"}
                              className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 text-slate-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-slate-500 disabled:hover:border-slate-200"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {showAddForm && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center px-4 py-6 z-50 overflow-y-auto">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 relative my-auto">
            <button
              onClick={() => setShowAddForm(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
            >
              <X className="w-5 h-5" />
            </button>
            <h2 className="text-base font-semibold text-slate-900 mb-4">Add Personnel</h2>

            {formError && (
              <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                {formError}
              </div>
            )}

            <form onSubmit={handleAddPersonnel} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Full Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">
                  Temporary Password
                </label>
                <input
                  type="text"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="Min. 8 characters"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">
                  Contact Number (optional)
                </label>
                <input
                  type="tel"
                  value={form.contact_number}
                  onChange={(e) => setForm({ ...form, contact_number: e.target.value })}
                  placeholder="e.g. 09171234567"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Role</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                >
                  {ROLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">
                  Department (optional)
                </label>
                <input
                  type="text"
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 disabled:bg-teal-400 text-white text-sm font-medium py-2.5 rounded-lg transition-colors mt-2"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Account"
                )}
              </button>
            </form>
          </div>
        </div>
      )}

      {editingPerson && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center px-4 py-6 z-50 overflow-y-auto">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 relative my-auto">
            <button
              onClick={closeEditForm}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
            >
              <X className="w-5 h-5" />
            </button>
            <h2 className="text-base font-semibold text-slate-900 mb-4">Edit Personnel</h2>

            {editError && (
              <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                {editError}
              </div>
            )}

            <form onSubmit={handleEditPersonnel} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Full Name</label>
                <input
                  type="text"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Email</label>
                <input
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                />
                <p className="text-xs text-slate-400 mt-1">
                  Note: this updates the profile record only, not the login email.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">
                  Contact Number (optional)
                </label>
                <input
                  type="tel"
                  value={editForm.contact_number}
                  onChange={(e) => setEditForm({ ...editForm, contact_number: e.target.value })}
                  placeholder="e.g. 09171234567"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Role</label>
                <select
                  value={editForm.role}
                  onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                >
                  {ROLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">
                  Department (optional)
                </label>
                <input
                  type="text"
                  value={editForm.department}
                  onChange={(e) => setEditForm({ ...editForm, department: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                />
              </div>

              <button
                type="submit"
                disabled={editSubmitting}
                className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 disabled:bg-teal-400 text-white text-sm font-medium py-2.5 rounded-lg transition-colors mt-2"
              >
                {editSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Changes"
                )}
              </button>
            </form>
          </div>
        </div>
      )}

      {deletingPerson && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center px-4 py-6 z-50 overflow-y-auto">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 relative my-auto">
            <button
              onClick={closeDeleteConfirm}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                <Trash2 className="w-4 h-4 text-red-600" />
              </div>
              <h2 className="text-base font-semibold text-slate-900">Delete Personnel</h2>
            </div>

            <p className="text-sm text-slate-500 mb-4">
              Are you sure you want to delete{" "}
              <span className="font-medium text-slate-700">{deletingPerson.name}</span>? This
              removes their profile record and cannot be undone.
            </p>

            {deleteError && (
              <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                {deleteError}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={closeDeleteConfirm}
                className="flex-1 text-sm font-medium px-4 py-2.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeletePersonnel}
                disabled={deleteSubmitting}
                className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
              >
                {deleteSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  "Delete"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}