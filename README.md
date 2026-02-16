# Art Grid Generator

A geometric art composition generator that creates unique SVG artwork.

## Features

- Generate random geometric art grids
- Customize dimensions, shape count, sizes, and patterns
- Interactive canvas with pan, zoom, and shape manipulation
- Export high-quality SVG files
- Automatic clipping to ensure shapes stay within bounds

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## GitHub Pages Deployment

This project is configured to automatically deploy to GitHub Pages when you push to the `main` branch.

### Setup Instructions

1. Push this repository to GitHub
2. Go to your repository Settings → Pages
3. Under "Build and deployment", select **Source: GitHub Actions**
4. Push to the `main` branch to trigger deployment

The site will be available at: `https://<username>.github.io/<repository-name>/`

### Manual Deployment

You can also trigger a manual deployment:
- Go to the Actions tab in your GitHub repository
- Select "Deploy to GitHub Pages" workflow
- Click "Run workflow" → "Run workflow"

## Technologies

- Vanilla JavaScript
- Vite
- SVG
