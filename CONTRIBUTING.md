# Contributing to StarkShield

Thank you for your interest in contributing to StarkShield! We welcome contributions from the community.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/starkshield.git`
3. Follow the [Getting Started Guide](./getting-started.md) to set up your development environment
4. Create a new branch: `git checkout -b feature/your-feature-name`

## Development Workflow

### Before You Start

- Check existing [issues](https://github.com/your-org/starkshield/issues) to avoid duplicates
- Create an issue to discuss major changes before implementing
- Join our [Discord](https://discord.gg/starkshield) for real-time discussion

### Code Style

#### Cairo
- Follow [Cairo best practices](https://cairo-lang.org/docs/how_to_write_cairo_code.html)
- Use `scarb fmt` to format code
- Run `scarb build` before committing

#### Rust
- Follow [Rust style guidelines](https://doc.rust-lang.org/style-guide/)
- Run `cargo fmt` to format code
- Run `cargo clippy` to catch common mistakes

#### TypeScript/JavaScript
- Follow [Airbnb JavaScript Style Guide](https://github.com/airbnb/javascript)
- Run `npm run lint` before committing
- Use TypeScript strict mode

### Making Changes

1. **Write tests** for new functionality
2. **Update documentation** if needed
3. **Follow commit message conventions**:
   - `feat:` New feature
   - `fix:` Bug fix
   - `docs:` Documentation changes
   - `test:` Test changes
   - `refactor:` Code refactoring
   - `chore:` Maintenance tasks

Example: `feat: add batch settlement support`

### Testing

```bash
# Run all tests
make test

# Run specific test suite
make test-contracts
make test-solver
make test-circuits

# Run with coverage
cd contracts && snforge test --coverage
cd solver && cargo tarpaulin
cd frontend && npm run test:coverage
```

### Pull Request Process

1. **Ensure all tests pass**
2. **Update the README.md** if needed
3. **Fill out the PR template**:
   - What does this PR do?
   - Why is this change needed?
   - How was this tested?
   - Screenshots (if applicable)

4. **Request review** from maintainers
5. **Address feedback** promptly
6. **Wait for CI** to pass

## Code Review Criteria

### Security
- No hardcoded secrets or keys
- Proper access control
- Protection against common vulnerabilities

### Performance
- Efficient algorithms
- Minimal storage usage
- Optimized gas costs (for contracts)

### Maintainability
- Clear, documented code
- Consistent naming conventions
- Modular design

### Testing
- Comprehensive test coverage
- Edge case handling
- Integration tests for cross-component features

## Areas for Contribution

### High Priority
- [ ] ZK circuit optimizations
- [ ] Starknet account abstraction integration
- [ ] TEE-secured solver implementation
- [ ] Frontend wallet integrations

### Medium Priority
- [ ] Additional test coverage
- [ ] Documentation improvements
- [ ] CI/CD pipeline enhancements
- [ ] Performance benchmarking

### Documentation
- [ ] Tutorial videos
- [ ] Architecture diagrams
- [ ] API reference updates
- [ ] Translation to other languages

## Community Guidelines

### Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on the code, not the person
- Help others learn and grow

### Communication

- **Discord**: Real-time chat and support
- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: General questions and ideas
- **Twitter**: Announcements and updates

## Recognition

Contributors will be:
- Listed in the README
- Mentioned in release notes
- Invited to contributor calls
- Eligible for bounties (if applicable)

## Questions?

- Check the [FAQ](./faq.md)
- Ask in Discord
- Open a GitHub discussion

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Thank You!

Every contribution, no matter how small, helps make StarkShield better. We appreciate your time and effort! 🙏