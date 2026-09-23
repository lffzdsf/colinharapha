#!/usr/bin/env python3
"""Build the browser candidate index and compact photo atlases from TSE archives."""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import unicodedata
import zipfile
from pathlib import Path

from PIL import Image, ImageOps


ROLE_MAP = {
    "DEPUTADO ESTADUAL": "estadual",
    "SENADOR": "senador",
    "GOVERNADOR": "governador",
    "PRESIDENTE": "presidente",
}

CELL_WIDTH = 120
CELL_HEIGHT = 168
ATLAS_COLUMNS = 5
PHOTOS_PER_ATLAS = 50


def read_csv(archive: zipfile.ZipFile, filename: str) -> list[dict[str, str]]:
    raw = archive.read(filename).decode("latin1")
    return list(csv.DictReader(raw.splitlines(), delimiter=";"))


def search_text(*parts: str) -> str:
    value = " ".join(parts).casefold()
    value = unicodedata.normalize("NFD", value)
    return "".join(char for char in value if unicodedata.category(char) != "Mn")


def candidate_record(row: dict[str, str], office: str) -> dict[str, str | list[int]]:
    name = row["NM_URNA_CANDIDATO"].strip()
    full_name = row["NM_CANDIDATO"].strip()
    number = row["NR_CANDIDATO"].strip()
    party = row["SG_PARTIDO"].strip()
    return {
        "id": row["SQ_CANDIDATO"],
        "office": office,
        "name": name,
        "fullName": full_name,
        "number": number,
        "party": party,
        "photo": "",
        "search": search_text(name, full_name, number, party),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", required=True, type=Path)
    parser.add_argument("--photos-mg", required=True, type=Path)
    parser.add_argument("--photos-br", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    data_dir = args.out / "data"
    atlas_dir = args.out / "assets" / "atlases"
    data_dir.mkdir(parents=True, exist_ok=True)
    atlas_dir.mkdir(parents=True, exist_ok=True)
    for stale_atlas in atlas_dir.glob("candidates-*.webp"):
        stale_atlas.unlink()

    with zipfile.ZipFile(args.candidates) as candidates_zip:
        mg_rows = read_csv(candidates_zip, "consulta_cand_2026_MG.csv")
        br_rows = read_csv(candidates_zip, "consulta_cand_2026_BR.csv")

    rows = [row for row in mg_rows if row["DS_CARGO"] in ROLE_MAP]
    rows += [row for row in br_rows if row["DS_CARGO"] == "PRESIDENTE"]

    raphael_row = next(
        row
        for row in mg_rows
        if row["DS_CARGO"] == "DEPUTADO FEDERAL"
        and row["NR_CANDIDATO"] == "1038"
        and row["NM_URNA_CANDIDATO"].upper() == "RAPHAEL MOTA"
    )
    raphael = candidate_record(raphael_row, "federal")

    row_records: list[tuple[dict[str, str], dict[str, str | list[int]]]] = []
    for row in rows:
        row_records.append((row, candidate_record(row, ROLE_MAP[row["DS_CARGO"]])))
    row_records.sort(key=lambda item: (item[1]["office"], item[1]["name"], item[1]["number"]))
    records = [record for _, record in row_records]

    missing_photos: list[str] = []
    photo_jobs: list[tuple[dict[str, str], dict[str, str | list[int]], str]] = [
        (raphael_row, raphael, "MG")
    ]
    for row, record in row_records:
        photo_jobs.append((row, record, "BR" if row["DS_CARGO"] == "PRESIDENTE" else "MG"))

    with zipfile.ZipFile(args.photos_mg) as photos_mg, zipfile.ZipFile(args.photos_br) as photos_br:
        archives = {"MG": photos_mg, "BR": photos_br}
        archive_names = {key: set(archive.namelist()) for key, archive in archives.items()}
        available_jobs: list[tuple[dict[str, str | list[int]], str, zipfile.ZipFile]] = []

        for row, record, prefix in photo_jobs:
            filename = f"F{prefix}{row['SQ_CANDIDATO']}_div.jpg"
            if filename not in archive_names[prefix]:
                missing_photos.append(filename)
                continue
            available_jobs.append((record, filename, archives[prefix]))

        for atlas_index in range(math.ceil(len(available_jobs) / PHOTOS_PER_ATLAS)):
            chunk = available_jobs[
                atlas_index * PHOTOS_PER_ATLAS : (atlas_index + 1) * PHOTOS_PER_ATLAS
            ]
            rows_in_atlas = math.ceil(len(chunk) / ATLAS_COLUMNS)
            atlas_width = CELL_WIDTH * ATLAS_COLUMNS
            atlas_height = CELL_HEIGHT * rows_in_atlas
            atlas = Image.new("RGB", (atlas_width, atlas_height), "white")
            atlas_filename = f"candidates-{atlas_index:02d}.webp"

            for position, (record, filename, archive) in enumerate(chunk):
                with Image.open(io.BytesIO(archive.read(filename))) as photo:
                    photo = ImageOps.exif_transpose(photo).convert("RGB")
                    fitted = ImageOps.fit(
                        photo,
                        (CELL_WIDTH, CELL_HEIGHT),
                        method=Image.Resampling.LANCZOS,
                        centering=(0.5, 0.28),
                    )
                x = (position % ATLAS_COLUMNS) * CELL_WIDTH
                y = (position // ATLAS_COLUMNS) * CELL_HEIGHT
                atlas.paste(fitted, (x, y))
                record["photo"] = f"assets/atlases/{atlas_filename}"
                record["photoRect"] = [
                    x,
                    y,
                    CELL_WIDTH,
                    CELL_HEIGHT,
                    atlas_width,
                    atlas_height,
                ]

            atlas.save(atlas_dir / atlas_filename, "WEBP", quality=78, method=6)

    generated_date = mg_rows[0]["DT_GERACAO"]
    generated_time = mg_rows[0]["HH_GERACAO"]
    payload = {
        "source": "Tribunal Superior Eleitoral (TSE)",
        "sourceUrl": "https://dadosabertos.tse.jus.br/dataset/candidatos-2026",
        "updatedAt": f"{generated_date} às {generated_time[:5]}",
        "state": "MG",
        "raphael": raphael,
        "candidates": records,
    }

    (data_dir / "candidates.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "candidates": len(records),
                "atlases": len(list(atlas_dir.glob("candidates-*.webp"))),
                "missing_photos": len(missing_photos),
                "updated_at": payload["updatedAt"],
                "raphael_photo": bool(raphael["photo"]),
            },
            ensure_ascii=False,
        )
    )
    if missing_photos:
        print("Missing:", ", ".join(missing_photos[:20]))


if __name__ == "__main__":
    main()
