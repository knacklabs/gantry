# PnP — Branch Naming Standards

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

*For all Git-based development across projects*

---

## 🎯 **1. Purpose**
This playbook defines our **branch naming conventions** and how we operate using the **Git Flow workflow**.
Goals:
- Maintain consistency across all projects
- Prevent chaos during releases
- Make code reviews and CI/CD predictable
- Enforce clean Git hygiene
- Ensure easy collaboration across teams

---

## 🔀 **2. Git Flow — Our Branching Workflow**
We follow the popular **Git Flow branching model**, originally introduced by Vincent Driessen, designed for clean release management and collaborative development.

#### 🔗 For further reading:
- [https://nvie.com/posts/a-successful-git-branching-model/](https://nvie.com/posts/a-successful-git-branching-model/)
- [https://www.atlassian.com/git/tutorials/comparing-workflows/gitflow-workflow](https://www.atlassian.com/git/tutorials/comparing-workflows/gitflow-workflow)
- [https://deepsource.io/blog/git-branching-strategies/](https://deepsource.io/blog/git-branching-strategies/)

#### 🧵 Git Flow includes five core branch types:

#### **1. **`**main**`** (or **`**master**`**)**
- Always reflects **production-ready code**.
- Every commit here is deployable.

#### **2. **`**develop**`
- Integration branch for the next release cycle.
- All feature work merges into `develop`.

#### **3. **`**feature/***`
- Created from `develop`.
- Used for new features, enhancements, or non-production bugs.
- Merged back into `develop`.
- Deleted after merge.

#### **4. **`**release/***`
- Created when preparing a production release.
- Used for final QA, testing, polishing.
- Merged into both `main` and `develop`.

#### **5. **`**hotfix/***`
- Created from `main`.
- Used for fixing production issues.
- Must be merged back into **both** `main` and `develop` to ensure persistence.

---

## 🏷️ **3. Branch Naming Convention**
All branches must follow this mandatory structure:
```plain text
<BRANCH_TYPE>/<TICKET_NUMBER>-<short-feature-title>

```

#### Components:
- **BRANCH_TYPE** → `feature`, `hotfix`, or `release`
- **TICKET_NUMBER** → Jira/Asana/Linear task ID
- **short-feature-title** → hyphen-separated, lowercase description

---

## 📌 4. Examples

#### ✔ Feature branch
```plain text
feature/KnackLabs-101-google-auth

```
(From PDF)

#### ✔ Hotfix branch
```plain text
hotfix/BUG-101-invoice-generation-issue

```
(From PDF)

#### ✔ Release branch
```plain text
release/1.4.0

```

---

## 🔧 **5. Rules for Creating and Merging Branches**

### **5.1 Feature Branches**
1. Create from:
```plain text
develop

```
1. Work on the feature.
1. Push and raise a PR → **back into **`**develop**`.
1. Merge only after code review & fixes.
1. Delete the feature branch after merge.

---

### **5.2 Hotfix Branches**
1. Create from:
```plain text
main

```
1. Fix the production issue.
1. Raise PR → **back into **`**main**`.
1. After merge → **backmerge to lower branches**:
```plain text
main → release → develop

```
1. Delete hotfix branch after merge.

---

### **5.3 Release Branches**
1. Created when preparing for a new production release.
1. Work includes:
  - QA fixes
  - Minor polish
  - Pre-release checks
1. Merged into **both**:
```plain text
main
develop

```

---

## 🔄 **6. Backmerging (Mandatory for Hotfixes)**
Hotfixes introduce new commits into `main` that do **not** exist in `develop`.
To avoid losing fixes:
```plain text
main → release → develop

```
This ensures:
- Develop stays ahead
- Release remains aligned
- No regression is introduced

---

## 🧹 **7. Branch Cleanup Rules**
- Always delete feature/hotfix/release branches after merging.
- Prevents stale branches.
- Keeps repository clean & lightweight.
- All history is safely preserved in the main branches.

---

## 📝 **8. Developer Checklist**
- [ ] Branch name follows `<type>/<ticket>-<title>`
- [ ] Branch created from correct base (`develop` or `main`)
- [ ] PR raised to correct target (`develop` or `main`)
- [ ] Code reviewed & fixes applied
- [ ] Branch deleted after merge
- [ ] If hotfix → backmerge performed

---

## 🧾 **9. Reviewer Checklist**
- [ ] Branch type matches work being done
- [ ] Naming convention followed
- [ ] PR target branch correct
- [ ] No direct commits to `main` or `develop`
- [ ] Hotfix PR merged & backmerged
- [ ] Feature PR merged & cleaned up

---

## 🎉 Playbook Complete
If you want, I can also prepare:
- A **Git Flow Diagram** (ASCII + Mermaid)
- A **Notion template** for PR reviews
- A **branch management SOP** for tech leads
- A **commit message playbook** to accompany this one
Just tell me!
