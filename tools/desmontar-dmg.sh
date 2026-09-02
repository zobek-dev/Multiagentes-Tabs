#!/usr/bin/env bash
# bundle_dmg.sh falla si el volumen que va a crear ya está montado, y un
# empaquetado interrumpido deja montados tanto el temporal («dmg.XXXX») como el
# definitivo («Multiagentes»). Se desmontan antes de volver a construir.
set -u
[ "$(uname)" = "Darwin" ] || exit 0

for volumen in /Volumes/dmg.* /Volumes/Multiagentes*; do
  [ -d "$volumen" ] || continue
  echo "desmontando $volumen"
  hdiutil detach "$volumen" -force >/dev/null 2>&1 || true
done
exit 0
