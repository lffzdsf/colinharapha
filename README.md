# Colinha Virtual — Raphael Mota 1038

Página mobile-first para montar uma colinha das Eleições 2026 em Minas Gerais. Raphael Mota (1038) permanece definido para deputado federal; as demais escolhas são pesquisadas por nome ou número.

## Funcionalidades

- Busca por nome ou número com foto oficial de urna
- Dois campos independentes para o Senado
- Prévia nos formatos Feed 4:5 e Story 9:16
- Download em PNG 1080 × 1350 ou 1080 × 1920
- Compartilhamento nativo da imagem em celulares compatíveis
- Base oficial de candidaturas do TSE

## Atualizar a base do TSE

Baixe os arquivos `consulta_cand_2026.zip`, `foto_cand2026_MG_div.zip` e `foto_cand2026_BR_div.zip` no [Portal de Dados Abertos do TSE](https://dadosabertos.tse.jus.br/dataset/candidatos-2026) e execute:

```bash
python scripts/prepare_tse_data.py \
  --candidates /caminho/consulta_cand_2026.zip \
  --photos-mg /caminho/foto_cand2026_MG_div.zip \
  --photos-br /caminho/foto_cand2026_BR_div.zip \
  --out .
```

A publicação no GitHub Pages ocorre automaticamente a cada envio para a branch `main`. O fluxo de publicação baixa a versão mais recente da base do TSE e gera a lista e as fotos antes de colocar o site no ar; esses arquivos derivados não precisam ficar versionados no repositório.
