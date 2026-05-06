// Changelogen config — see https://github.com/unjs/changelogen#configuration
export default {
  types: {
    feat:     { title: "Features",     semver: "minor" as const },
    fix:      { title: "Bug Fixes",    semver: "patch" as const },
    perf:     { title: "Performance",  semver: "patch" as const },
    refactor: { title: "Refactor",     semver: "patch" as const },
    docs:     { title: "Docs",         semver: "patch" as const },
    chore:    { title: "Chores" },
    test:     { title: "Tests" },
    build:    { title: "Build" },
    ci:       { title: "CI" },
    style:    { title: "Style" },
    revert:   { title: "Reverts" },
  },
  scopeMap: {
    api:    "api",
    web:    "web",
    mcp:    "mcp",
    skills: "skills",
    repo:   "repo",
    deps:   "deps",
  },
  excludeAuthors: ["renovate[bot]", "dependabot[bot]"],
};
