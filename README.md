# Trade Companion Pro

Clone this repo https://github.com/daveprinter/plutotraderbott.git including backend and frontend and supabase using this code style:# Clone into a temporary directory.

git clone https://github.com/daveprinter/plutotraderbott.git



# Inspect structure.

ls -la /tmp/derivgoat



# Copy application source and public assets.

cp -r /tmp/derivgoat/src ./

cp -r /tmp/derivgoat/public ./



# Copy project configuration files.

cp /tmp/derivgoat/package.json    /tmp/derivgoat/bun.lock    /tmp/derivgoat/bunfig.toml    /tmp/derivgoat/components.json    /tmp/derivgoat/eslint.config.js    /tmp/derivgoat/tsconfig.json    /tmp/derivgoat/vite.config.ts    /tmp/derivgoat/AGENTS.md    /tmp/derivgoat/.prettierrc    /tmp/derivgoat/.prettierignore ./



# Copy Lovable-specific configuration.

cp -r /tmp/derivgoat/.lovable ./



# Install dependencies.

bun install

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://titanichub.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/786366e4-9902-43dc-9208-9f8c7928b9b9).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
