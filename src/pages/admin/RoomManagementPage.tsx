import { useEffect, useMemo, useState } from "react";
import {
  Menu,
  Edit,
  Trash2,
  CheckCircle,
  XCircle,
  Loader2,
  Flag,
  Search,
  Plus,
} from "lucide-react";
import { Badge, Input, Table, TableHeader, TableRow, TableCell } from "../../ui";
import { useRooms } from "../../context/RoomsContext";
import type { Room } from "../../data/Data";

interface RoomManagementRow {
  id: string;
  name: string;
  floor: string;
  type: string | null;
  active: boolean;
  deviceCount: number;
}

interface RoomManagementPageProps {
  userRole: "admin" | "maintenance" | "security";
}

// Shared style objects to avoid TypeScript % parsing issues in inline styles
const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid #e2e8f0",
  fontSize: 13.5,
};

const buttonStyle = {
  borderRadius: 6,
  padding: "8px 16px",
  fontWeight: 700,
  fontSize: 13,
  border: "none",
  cursor: "pointer",
};

const tableCellStyle = {
  borderBottom: "1px solid #e2e8f0",
};

function useRoomManagementRooms(): RoomManagementRow[] {
  const { rooms, loading } = useRooms();
  const [rows, setRows] = useState<RoomManagementRow[]>([]);
  const [page, setPage] = useState(1);
  const pageSize = 20;

  useEffect(() => {
    if (loading) return;
    const mapped = rooms.map((r) => ({
      id: r.id,
      name: r.name,
      floor: r.floor ?? "",
      type: r.type ?? "",
      active: r.active ?? true,
      deviceCount: 1,
    }));
    setRows(mapped);
  }, [rooms, loading]);

  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return rows.slice(start, end);
}

export default function RoomManagementPage({ userRole }: RoomManagementPageProps) {
  const { rooms, loading, addRoom, removeRoom, setSelectedId, selectedId } = useRooms();
  const [showAdd, setShowAdd] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [editRoom, setEditRoom] = useState<RoomManagementRow | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; show: boolean } | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return rooms;
    const q = search.toLowerCase();
    return rooms.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.floor ?? "").toLowerCase().includes(q) || (r.type ?? "").toLowerCase().includes(q)
    );
  }, [rooms, search]);

  const paginated = useMemo(() => {
    const start = (page - 1) * 20;
    const end = start + 20;
    return filtered.slice(start, end);
  }, [filtered, page]);

  const canManage = userRole === "admin";

  function handleAdd() {
    setEditRoom(null);
    setShowAdd(true);
  }

  function handleEdit(room: RoomManagementRow) {
    setEditRoom({
      id: room.id,
      name: room.name,
      floor: room.floor,
      type: room.type,
      active: room.active,
    });
    setShowEdit(true);
  }

  function handleDelete(id: string) {
    setConfirmDelete({ id, show: true });
  }

  async function doDelete(id: string) {
    const { error } = await removeRoom(id);
    if (error) {
      console.error("Failed to delete room:", error.message);
      return;
    }
    setConfirmDelete(null);
  }

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between gap-3 mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Room Management</h1>
        {canManage && (
          <button
            onClick={() => setShowAdd(true)}
            style={buttonStyle}
          >
            <Plus size={15} /> Add Room
          </button>
        )}
      </div>

      {/* Search filter */}
      {canManage && (
        <div className="mb-4">
          <Input
            placeholder="Search rooms (name, floor, type)..."
            value={search}
            onValueChange={(v) => setSearch(v)}
            style={inputStyle}
          />
        </div>
      )}

      {loading && (
        <p className="text-slate-500">Loading rooms...</p>
      )}

      {/* Rooms table */}
      {paginated.length > 0 || !loading ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableCell style={{ ...tableCellStyle, width: "40px" }}>#</TableCell>
              <TableCell>Room Name</TableCell>
              <TableCell style={{ ...tableCellStyle, width: "120px" }}>Floor</TableCell>
              <TableCell style={{ ...tableCellStyle, width: "140px" }}>Type</TableCell>
              <TableCell style={{ ...tableCellStyle, width: "80px" }}>Status</TableCell>
              <TableCell style={{ ...tableCellStyle, width: "100px" }}>Devices</TableCell>
              {canManage && <TableCell />}
            </TableRow>
          </TableHeader>

          {paginated.map((r, i) => (
            <TableRow key={r.id} style={tableCellStyle}>
              <TableCell>{i + 1}</TableCell>
              <TableCell>{r.name}</TableCell>
              <TableCell>{r.floor || "—"}</TableCell>
              <TableCell>
                {r.type ? (
                  <Badge label={r.type} tone="success" />
                ) : (
                  <Badge label="—" tone="muted" />
                )}
              </TableCell>
              <TableCell>
                {r.active ? (
                  <Badge label="Active" tone="success" />
                ) : (
                  <Badge label="Inactive" tone="warning" />
                )}
              </TableCell>
              <TableCell>{r.deviceCount}</TableCell>
              {canManage && (
                <TableCell>
                  <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                    {r.active ? (
                      <>
                        <button
                          onClick={() => handleEdit(r)}
                          style={{
                            fontSize: 11,
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
                            fontSize: 11,
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
                          fontSize: 11,
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

          {paginated.length < total && !loading && (
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
        <p className="text-slate-500">No rooms found. Add a new room above.</p>
      )}

      {/* Add Room Modal */}
      {showAdd && (
        <div style={{ position: "fixed", left: 0, top: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", padding: 24, borderRadius: 12, width: 480, maxHeight: "80vh", overflowY: "auto" }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Add New Room</h2>
            <form
              onSubmit={(e: any) => {
                e.preventDefault();
                const form: RoomForm & { submitLabel?: string } = {
                  name: e.target.name.value,
                  floor: e.target.floor.value,
                  type: e.target.type.value,
                };
                addRoom(form);
                setShowAdd(false);
              }}
            >
              <Input
                name="name"
                placeholder="Room name (e.g. Room 106)"
                style={inputStyle}
                required
              />
              <Input
                name="floor"
                placeholder="Floor (e.g. Ground Floor)"
                type="text"
                style={inputStyle}
                required
              />
              <Input
                name="type"
                placeholder="Type (e.g. classroom, kitchen, lab, office, storage)"
                type="text"
                style={inputStyle}
                required
              />
              <div style={buttonStyle}>
                <button type="button" onClick={() => setShowAdd(false)} style={{ ...buttonStyle, border: "1px solid #e2e8f0", background: "#fff", color: "#334155" }}>Cancel</button>
                <button type="submit" style={{ ...buttonStyle, background: "#0d9488", color: "#fff" }}>Create Room</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Room Modal */}
      {showEdit && editRoom !== null && (
        <div style={{ position: "fixed", left: 0, top: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", padding: 24, borderRadius: 12, width: 480, maxHeight: "80vh", overflowY: "auto" }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Edit Room</h2>
            <form
              onSubmit={(e: any) => {
                e.preventDefault();
                const form: RoomForm & { submitLabel?: string } = {
                  name: e.target.name.value,
                  floor: e.target.floor.value,
                  type: e.target.type.value,
                };
                setShowEdit(false);
              }}
            >
              <Input
                name="name"
                defaultValue={editRoom.name}
                placeholder="Room name"
                style={inputStyle}
                required
              />
              <Input
                name="floor"
                defaultValue={editRoom.floor}
                placeholder="Floor"
                type="text"
                style={inputStyle}
                required
              />
              <Input
                name="type"
                defaultValue={editRoom.type ?? ""}
                placeholder="Type (e.g. classroom, kitchen, lab, office, storage)"
                type="text"
                style={inputStyle}
                required
              />
              <div style={buttonStyle}>
                <button type="button" onClick={() => setShowEdit(false)} style={{ ...buttonStyle, border: "1px solid #e2e8f0", background: "#fff", color: "#334155" }}>Cancel</button>
                <button type="submit" style={{ ...buttonStyle, background: "#0d9488", color: "#fff" }}>Update</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

interface RoomForm {
  name: string;
  floor: string;
  type: string;
}