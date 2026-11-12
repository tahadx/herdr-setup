#!/usr/bin/env sh
# Install this layout into a Herdr home.
#
#   ./install.sh                      # into ~/.config/herdr-app
#   HERDR_APP_HOME=/path ./install.sh # into another home (a test one, say)
#
# Copies the layout, the mods it uses and its theme, then merges the keys the
# layout needs into keys.json. The old keys.json is kept beside it. Nothing else
# in your Herdr home is touched, and Herdr's own mods are never written to.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}

if [ ! -d "$home" ]; then
  echo "No Herdr home at $home." >&2
  echo "Start Herdr once, or set HERDR_APP_HOME to the home you want." >&2
  exit 1
fi

# The ten mods of this bundle, by name: copying mods/ wholesale would take
# Herdr's own mods (and its scratch files) along with it.
BUNDLE="agents-list terminals-list footer icons search shortcuts worktrees sidebar-menu handle pane-header"

mkdir -p "$home/layouts" "$home/mods" "$home/themes"
cp "$here/layouts/workspace.json" "$home/layouts/"
cp "$here/layouts/workspace.svg" "$home/layouts/"
for mod in $BUNDLE; do
  if [ ! -d "$here/mods/$mod" ]; then
    echo "Missing mods/$mod in this bundle." >&2
    exit 1
  fi
  cp -R "$here/mods/$mod" "$home/mods/"
  # Herdr writes these into every mod folder; a copy from another version would
  # only mislead an editor. The app writes its own on the next start.
  rm -f "$home/mods/$mod/jsconfig.json" "$home/mods/$mod"/*.d.ts
done
[ -f "$here/themes/omarchy.json" ] && cp "$here/themes/omarchy.json" "$home/themes/"

# The keys this layout expects. They live in the layout's own section, so Herdr's
# layouts keep Alt+F and Ctrl+J/K for themselves.
keys="$home/keys.json"
if [ -f "$keys" ]; then
  cp "$keys" "$keys.bak.$(date +%s)"
fi

if command -v python3 >/dev/null 2>&1; then
  python3 - "$keys" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text()) if path.exists() else {}
ours = {
    "alt-f": "mod.open:search",
    "ctrl-j": "footer.dir_down",
    "ctrl-k": "footer.dir_up",
    "ctrl-shift-x": "terminals-list.close_pane",
    "ctrl-shift-w": "terminals-list.close_tab",
    "ctrl-shift-m": "footer.flip_layout",
    "ctrl-shift-d": "footer.worktree_new",
}
section = data.setdefault("layout:workspace", {})
added = [k for k in ours if k not in section]
section.update(ours)
path.write_text(json.dumps(data, indent=2) + "\n")
print(f"keys.json: {len(added)} key(s) added to layout:workspace" if added else "keys.json: already has this layout's keys")
PY
else
  cat <<'EOF'
python3 was not found, so keys.json was not merged. Add this section by hand:

  "layout:workspace": {
    "alt-f": "mod.open:search",
    "ctrl-j": "footer.dir_down",
    "ctrl-k": "footer.dir_up",
    "ctrl-shift-x": "terminals-list.close_pane",
    "ctrl-shift-w": "terminals-list.close_tab",
    "ctrl-shift-m": "footer.flip_layout",
    "ctrl-shift-d": "footer.worktree_new"
  }
EOF
fi

cat <<EOF

Installed into $home

Next:
  herdr-app do layout.switch --name workspace
  (or Ctrl+Shift+L to cycle layouts)

The mods load on their own; "herdr-app check $home/mods/search" proves one.
EOF
