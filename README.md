# ◈ Open Photo Editor

Un éditeur photo open source, léger et moderne, construit avec Flask et Pillow.  
**Tous les calculs sont effectués en local** — aucune image n'est envoyée vers des services tiers.

![Open Photo Editor](https://img.shields.io/badge/version-1.0-yellow?style=flat-square)
![Python](https://img.shields.io/badge/python-3.9+-blue?style=flat-square)
![Flask](https://img.shields.io/badge/flask-3.0+-green?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-orange?style=flat-square)

---

## ✨ Fonctionnalités

### Réglages
- **Luminosité** — de 0 à 200%
- **Exposition** — correction gamma (−100 à +100)
- **Contraste** — de 0 à 200%
- **Hautes lumières** — récupération des zones claires
- **Ombres** — éclaircissement des zones sombres
- **Saturation** — de 0 (N&B) à 300%
- **Température** — correction chaud/froid
- **Netteté** — de 0 à 300%

### Filtres créatifs
- Noir & Blanc, Sépia, Inversé
- Auto Contraste, Égalisation
- Vignette, Flou doux
- Accentuer, Contours, Embossage

### Transformations
- Rotation −90° / +90°
- Miroir horizontal et vertical
- Recadrage interactif (dessin sur l'image)

### Export
- JPEG, PNG, WebP
- Contrôle de la qualité (10–100%)
- Téléchargement direct dans le navigateur

### UX
- Glisser-déposer d'images
- Historique avec 20 étapes (Ctrl+Z)
- Zoom molette + contrôles (Ctrl +/−/0)
- Raccourcis clavier (Ctrl+S, Ctrl+O…)
- Interface réactive et moderne

---

## 🚀 Installation

```bash
# 1. Cloner le dépôt
git clone https://github.com/votre-user/open-photo-editor.git
cd open-photo-editor

# 2. Créer un environnement virtuel
python -m venv venv
source venv/bin/activate   # Windows : venv\Scripts\activate

# 3. Installer les dépendances
pip install -r requirements.txt

# 4. Lancer l'application
python app.py
```

Ouvrez `http://localhost:5000` dans votre navigateur.

---

## 📁 Structure du projet

```
open-photo-editor/
├── app.py                  # Application Flask principale
├── requirements.txt        # Dépendances Python
├── README.md
├── templates/
│   └── index.html          # Interface unique (SPA-style)
├── static/
│   ├── css/
│   │   └── style.css       # Styles complets
│   └── js/
│       └── editor.js       # Logique frontend
├── uploads/                # Images originales (temporaire)
└── processed/              # Images traitées (temporaire)
```

---

## 🔑 Raccourcis clavier

| Raccourci | Action |
|-----------|--------|
| `Ctrl+O` | Ouvrir une image |
| `Ctrl+S` | Télécharger |
| `Ctrl+Z` | Annuler |
| `Ctrl++` | Zoom avant |
| `Ctrl+-` | Zoom arrière |
| `Ctrl+0` | Ajuster le zoom |
| `Échap` | Annuler le recadrage |

---

## 🛠️ Stack technique

- **Backend** : Python 3.9+, Flask 3.x
- **Traitement image** : Pillow (PIL), NumPy
- **Frontend** : HTML/CSS/JS vanilla (aucun framework)
- **Fonts** : Fraunces, Instrument Sans, DM Mono (Google Fonts)

---

## 📄 Licence

MIT License — libre d'utilisation, modification et distribution.

---

> Made with ♥ — Open Source, local-first.
# Open-Photo-Editor
