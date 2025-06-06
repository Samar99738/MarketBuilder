# Contributing to Strategy Builder MCP Server

Thank you for your interest in contributing to the Strategy Builder MCP Server! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies: `npm install`
4. Copy `.env.example` to `.env` and configure your environment variables

## Development Setup

### Prerequisites

- Node.js 18+
- npm or pnpm
- TypeScript

### Running the Development Server

```bash
npm run dev
```

### Building for Production

```bash
npm run build
npm start
```

## Code Style

- Use TypeScript for all new code
- Follow existing code patterns and conventions
- Keep functions small and focused
- Add appropriate error handling and logging

## Testing

Before submitting a PR:

1. Test the counter functions: `node test-aws-counter.js`
2. Test the server deployment: `node test-aws-deployment.js`
3. Test the server locally: `node test-server.js`

## Submitting Changes

1. Create a feature branch from `main`
2. Make your changes
3. Test your changes thoroughly
4. Commit with clear, descriptive messages
5. Push to your fork and submit a pull request

## Pull Request Guidelines

- Provide a clear description of what your PR does
- Include steps to test the changes
- Update documentation if needed
- Keep PRs focused and atomic

## Security

- Never commit sensitive information (API keys, private keys, etc.)
- Always use environment variables for configuration
- Review the `.env.example` file for required variables

## Questions?

Feel free to open an issue for questions or discussions about the project.
