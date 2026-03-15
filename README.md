# ◈ Open Photo Editor

[![Version](https://img.shields.io/badge/version-2.0-yellow?style=flat-square)](https://github.com/CTHE0/Open-Photo-Editor)
[![Python](https://img.shields.io/badge/python-3.9+-blue?style=flat-square)](https://python.org)
[![Flask](https://img.shields.io/badge/flask-3.0+-green?style=flat-square)](https://flask.palletsprojects.com)
[![License](https://img.shields.io/badge/license-MIT-orange?style=flat-square)](LICENSE)
[![Open Source](https://img.shields.io/badge/open%20source-❤-red?style=flat-square)](https://github.com/CTHE0/Open-Photo-Editor)

> **Éditeur photo open source** avec retouche simple ET montage multi-calques.  
> **100% local** — aucune image n'est envoyée vers des services tiers.

---

## ✨ Deux modes

### 🖼 Mode Retouche
Édition rapide d'une image : réglages, filtres, transformations, export.

### 🎭 Mode Calques (nouveau v2.0)
Montage photo professionnel avec :
- **Calques multiples** : image, couleur unie, dégradé, texte
- **Modes de fusion** : Normal, Multiplier, Écran, Superposition, Lumière douce/dure, Différence, Exclusion, Assombrir, Éclaircir, Esquiver, Densité, Luminosité
- **Opacité par calque** (0–100%)
- **Réglages indépendants** par calque (luminosité, contraste, saturation, etc.)
- **Filtres par calque** (N&B, sépia, vignette, grain, etc.)
- **Transformations par calque** (rotation, miroir, position X/Y)
- **Réorganisation** (monter/descendre les calques)
- **Duplication de calque**
- **Fusion de calques** (merge)
- **Aplatissement** (flatten all)
- **Export final** pleine résolution (JPEG, PNG, WebP)

---

## 🛠 Fonctionnalités détaillées

### Réglages (par image ou par calque)
| Réglage | Plage |
|---------|-------|
| Luminosité | 0–200% |
| Exposition | −100 à +100 |
| Contraste | 0–200% |
| Hautes lumières | −100 à +100 |
| Ombres | −100 à +100 |
| Saturation | 0–300% |
| Température | −100 à +100 |
| Netteté | 0–300% |

### Filtres créatifs
Noir & Blanc · Sépia · Inversé · Auto Contraste · Égalisation · Vignette · Flou doux · Accentuer · Grain · Embossage

### Modes de fusion (calques)
Normal · Multiplier · Écran · Superposition · Lumière douce · Lumière dure · Différence · Exclusion · Assombrir · Éclaircir · Esquiver couleur · Densité couleur · Luminosité

---

## 🚀 Installation

```bash
# 1. Cloner
git clone https://github.com/CTHE0/Open-Photo-Editor.git
cd Open-Photo-Editor

# 2. Environnement virtuel
python -m venv venv
source venv/bin/activate     # Windows : venv\Scripts\activate

# 3. Dépendances
pip install -r requirements.txt

# 4. Lancer
python app.py
# → http://localhost:5000
```

---

## 📁 Structure

```
Open-Photo-Editor/
├── app.py                  # Flask + moteur de composition
├── requirements.txt
├── README.md
├── templates/
│   └── index.html          # Interface complète (SPA)
├── static/
│   ├── css/style.css       # Thème sombre industriel
│   └── js/editor.js        # Logique frontend
└── uploads/                # Stockage temporaire
```

---

## 🔑 Raccourcis clavier

| Raccourci | Action |
|-----------|--------|
| `Ctrl+O` | Ouvrir une image |
| `Ctrl+S` | Télécharger / Exporter |
| `Ctrl+Z` | Annuler (mode retouche) |
| `Ctrl++` | Zoom avant |
| `Ctrl+-` | Zoom arrière |
| `Ctrl+0` | Ajuster le zoom |
| `Échap` | Annuler recadrage / fermer modal |
| `Suppr` | Supprimer le calque actif (mode calques) |

---

## 🧱 Stack technique

| Couche | Technologie |
|--------|-------------|
| Backend | Python 3.9+, Flask 3.x |
| Traitement image | Pillow (PIL), NumPy |
| Frontend | HTML/CSS/JS vanilla — zéro framework |
| Fonts | Fraunces, Instrument Sans, DM Mono |

---

## 🗺 Roadmap

- [ ] Masques de calques
- [ ] Outil pinceau / dessin
- [ ] Suppression de fond (AI local)
- [ ] Import/export de projet (JSON)
- [ ] Recadrage interactif en mode calques
- [ ] Support multi-page / timeline

---

## 🤝 Contribution

Les PRs sont les bienvenues ! Ouvrez une issue avant de commencer un gros changement.

```bash
git checkout -b feature/ma-feature
# ... développement ...
git commit -m "feat: ma nouvelle fonctionnalité"
git push origin feature/ma-feature
# → Ouvrir une Pull Request
```

---

## 📄 Licence

MIT License — libre d'utilisation, modification et distribution.

---

> Made with ♥ — Open Source, local-first, aucune donnée envoyée nulle part.
