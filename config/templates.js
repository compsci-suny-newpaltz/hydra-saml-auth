/**
 * Workspace template definitions for student containers.
 * Each template specifies a Docker image with pre-installed tools and extensions.
 */

const TEMPLATES = {
    default: {
        id: 'default',
        name: 'Default',
        description: 'Basic development environment with Python, Java, Node.js',
        image: 'hydra-student-container:latest',
        tools: ['Python 3', 'Java 21', 'Node.js 20', 'Git', 'Docker'],
        extensions: [],
        category: 'general'
    },
    java: {
        id: 'java',
        name: 'Java Development',
        description: 'Java 21, Maven, Gradle, Spring Boot support',
        image: 'hydra-template-java:latest',
        tools: ['OpenJDK 21', 'Maven', 'Gradle 8.5', 'Node.js 20', 'Git', 'Docker'],
        extensions: [
            'vscjava.vscode-java-pack',
            'vmware.vscode-spring-boot',
            'vscjava.vscode-gradle',
            'vscjava.vscode-maven',
            'mtxr.sqltools'
        ],
        category: 'backend'
    },
    python: {
        id: 'python',
        name: 'Python Development',
        description: 'Python 3.11, pip, venv, Poetry, Jupyter',
        image: 'hydra-template-python:latest',
        tools: ['Python 3.11', 'pip', 'Poetry', 'Jupyter', 'Node.js 20', 'Git', 'Docker'],
        extensions: [
            'ms-python.python',
            'ms-python.pylance',
            'ms-toolsai.jupyter',
            'njpwerner.autodocstring',
            'ms-python.black-formatter'
        ],
        category: 'backend'
    },
    webdev: {
        id: 'webdev',
        name: 'Web Development',
        description: 'Node.js, Vue, React, PHP, SQLite, full-stack tools',
        image: 'hydra-template-webdev:latest',
        tools: ['Node.js 20', 'npm', 'pnpm', 'Vue CLI', 'React', 'PHP 8.1', 'SQLite', 'Git', 'Docker'],
        extensions: [
            'dbaeumer.vscode-eslint',
            'esbenp.prettier-vscode',
            'Vue.volar',
            'dsznajder.es7-react-js-snippets',
            'bradlc.vscode-tailwindcss',
            'Prisma.prisma',
            'mtxr.sqltools',
            'devsense.phptools-vscode'
        ],
        category: 'frontend'
    },
    devops: {
        id: 'devops',
        name: 'DevOps',
        description: 'Docker, Kubernetes, Terraform, Ansible, Helm',
        image: 'hydra-template-devops:latest',
        tools: ['Docker', 'kubectl', 'Helm', 'Terraform', 'Ansible', 'k9s', 'Git'],
        extensions: [
            'ms-azuretools.vscode-docker',
            'ms-kubernetes-tools.vscode-kubernetes-tools',
            'redhat.vscode-yaml',
            'hashicorp.terraform',
            'redhat.ansible',
            'timonwong.shellcheck'
        ],
        category: 'infrastructure'
    },
    datascience: {
        id: 'datascience',
        name: 'Data Science',
        description: 'Python, Jupyter, pandas, numpy, scikit-learn, TensorFlow, PyTorch',
        image: 'hydra-template-datascience:latest',
        tools: ['Python 3.11', 'Jupyter', 'pandas', 'numpy', 'scikit-learn', 'TensorFlow', 'PyTorch', 'Git', 'Docker'],
        extensions: [
            'ms-python.python',
            'ms-python.pylance',
            'ms-toolsai.jupyter',
            'ms-toolsai.datawrangler',
            'RandomFractalsInc.vscode-data-preview',
            'mechatroner.rainbow-csv'
        ],
        category: 'data'
    }
};

// Default template for new containers
const DEFAULT_TEMPLATE = 'default';

// Get template by ID, returns default if not found
function getTemplate(templateId) {
    return TEMPLATES[templateId] || TEMPLATES[DEFAULT_TEMPLATE];
}

// Validate template ID
function isValidTemplate(templateId) {
    return Object.prototype.hasOwnProperty.call(TEMPLATES, templateId);
}

// Get list of all templates for UI
function getAllTemplates() {
    return Object.values(TEMPLATES);
}

// Get templates by category
function getTemplatesByCategory(category) {
    return Object.values(TEMPLATES).filter(t => t.category === category);
}

module.exports = {
    TEMPLATES,
    DEFAULT_TEMPLATE,
    getTemplate,
    isValidTemplate,
    getAllTemplates,
    getTemplatesByCategory
};
