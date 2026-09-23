#!/usr/bin/env python3
"""Build the browser-ready 2026 candidate index from official TSE archives."""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import unicodedata
import zipfile
from pathlib import Path


ROLE_MAP = {
    "DEPUTADO ESTADUAL": "estadual",
    "SENADOR": "senador",
    "GOVERNADOR": "governador",
    "PRESIDENTE": "presidente",
}


def read_csv(archive: zipfile.ZipFile, filename: str) -> list[dict[str, str]]:
    raw = archive.read(filename).decode("latin1")
    return list(csv.DictReader(raw.splitlines(), delimiter=";"))


def search_text(*parts: str) -> str:
    value = " ".join(parts).casefold()
    value = unicodedata.normalize("NFD", value)
    return "".join(char for char in value if unicodedata.category(char) != "Mn")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", required=True, type=Path)
    parser.add_argument("--photos-mg", required=True, type=Path)
    parser.add_argument("--photos-br", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    data_dir = args.out / "data"
    photo_dir = args.out / "assets" / "candidates"
    data_dir.mkdir(parents=True, exist_ok=True)
    photo_dir.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(args.candidates) as candidates_zip:
        mg_rows = read_csv(candidates_zip, "consulta_cand_2026_MG.csv")
        br_rows = read_csv(candidates_zip, "consulta_cand_2026_BR.csv")

    rows = [row for row in mg_rows if row["DS_CARGO"] in ROLE_MAP]
    rows += [row for row in br_rows if row["DS_CARGO"] == "PRESIDENTE"]

    raphael = next(
        row
        for row in mg_rows
        if row["DS_CARGO"] == "DEPUTADO FEDERAL"
        and row["NR_CANDIDATO"] == "1038"
        and row["NM_URNA_CANDIDATO"].upper() == "RAPHAEL MOTA"
    )

    records: list[dict[str, str]] = []
    missing_photos: list[str] = []

    with zipfile.ZipFile(args.photos_mg) as photos_mg, zipfile.ZipFile(args.photos_br) as photos_br:
        mg_names = set(photos_mg.namelist())
        br_names = set(photos_br.namelist())

        def export_photo(row: dict[str, str], prefix: str, archive: zipfile.ZipFile, names: set[str]) -> str:
            filename = f"F{prefix}{row['SQ_CANDIDATO']}_div.jpg"
            if filename not in names:
                missing_photos.append(filename)
                return ""
            destination = photo_dir / filename
            with archive.open(filename) as source, destination.open("wb") as target:
                shutil.copyfileobj(source, target)
            return f"assets/candidates/{filename}"

        raphael_photo = export_photo(raphael, "MG", photos_mg, mg_names)

        for row in rows:
            is_president = row["DS_CARGO"] == "PRESIDENTE"
            prefix = "BR" if is_president else "MG"
            archive = photos_br if is_president else photos_mg
            names = br_names if is_president else mg_names
            name = row["NM_URNA_CANDIDATO"].strip()
            full_name = row["NM_CANDIDATO"].strip()
            number = row["NR_CANDIDATO"].strip()
            party = row["SG_PARTIDO"].strip()
            records.append(
                {
                    "id": row["SQ_CANDIDATO"],
                    "office": ROLE_MAP[row["DS_CARGO"]],
                    "name": name,
                    "fullName": full_name,
                    "number": number,
                    "party": party,
                    "photo": export_photo(row, prefix, archive, names),
                    "search": search_text(name, full_name, number, party),
                }
            )

    records.sort(key=lambda item: (item["office"], item["name"], item["number"]))
    generated_date = mg_rows[0]["DT_GERACAO"]
    generated_time = mg_rows[0]["HH_GERACAO"]
    payload = {
        "source": "Tribunal Superior Eleitoral (TSE)",
        "sourceUrl": "https://dadosabertos.tse.jus.br/dataset/candidatos-2026",
        "updatedAt": f"{generated_date} às {generated_time[:5]}",
        "state": "MG",
        "raphael": {
            "id": raphael["SQ_CANDIDATO"],
            "office": "federal",
            "name": raphael["NM_URNA_CANDIDATO"].strip(),
            "fullName": raphael["NM_CANDIDATO"].strip(),
            "number": raphael["NR_CANDIDATO"].strip(),
            "party": raphael["SG_PARTIDO"].strip(),
            "photo": raphael_photo,
        },
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
                "missing_photos": len(missing_photos),
                "updated_at": payload["updatedAt"],
                "raphael_photo": bool(raphael_photo),
            },
            ensure_ascii=False,
        )
    )
    if missing_photos:
        print("Missing:", ", ".join(missing_photos[:20]))


if __name__ == "__main__":
    main()
