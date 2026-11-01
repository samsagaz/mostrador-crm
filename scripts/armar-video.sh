#!/bin/bash
# Arma el video tutorial a partir de capturas PNG (1920x1080) con transiciones y el logo de DonWeb.
# Uso: scripts/armar-video.sh CARPETA_CAPTURAS [audio.mp3]
# Cada captura dura lo que diga su nombre: 05-bandeja@7.png dura 7 s (sin @, 5 s).
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=${1:?Pasá la carpeta con las capturas}
AUDIO=${2:-}
SALIDA=public/video/tutorial.mp4
FADE=0.6
mkdir -p public/video

# Placa de apertura y de cierre: el logo de DonWeb.
cp public/img/donweb.jpg "$DIR/00-donweb@2.5.jpg"
cp public/img/donweb.jpg "$DIR/zz-donweb@2.5.jpg"

mapfile -t FOTOS < <(ls "$DIR" | grep -E '\.(png|jpg)$' | sort)
ENTRADAS=() ; FILTRO="" ; OFFSET=0 ; PREV="v0"
for i in "${!FOTOS[@]}"; do
  f=${FOTOS[$i]}
  d=$(echo "$f" | grep -oE '@[0-9]+(\.[0-9]+)?' | tr -d '@' || true); d=${d:-5}
  ENTRADAS+=(-loop 1 -t "$d" -i "$DIR/$f")
  FILTRO+="[$i:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:white,setsar=1,fps=30,format=yuv420p[v$i];"
  if [ "$i" -gt 0 ]; then
    FILTRO+="[$PREV][v$i]xfade=transition=fade:duration=$FADE:offset=$OFFSET[x$i];"
    PREV="x$i"
  fi
  OFFSET=$(awk "BEGIN{print $OFFSET + $d - $FADE}")
done
FILTRO=${FILTRO%;}

if [ -n "$AUDIO" ]; then
  ffmpeg -loglevel error -y "${ENTRADAS[@]}" -i "$AUDIO" -filter_complex "$FILTRO" -map "[$PREV]" -map "${#FOTOS[@]}:a" \
    -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -shortest -movflags +faststart "$SALIDA"
else
  ffmpeg -loglevel error -y "${ENTRADAS[@]}" -filter_complex "$FILTRO" -map "[$PREV]" \
    -c:v libx264 -preset veryfast -crf 23 -movflags +faststart "$SALIDA"
fi
ffmpeg -loglevel error -y -i "$DIR/${FOTOS[1]}" -vf scale=1280:-1 -q:v 4 public/video/poster.jpg
echo "Listo: $SALIDA ($(du -h "$SALIDA" | cut -f1), $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SALIDA") s)"
