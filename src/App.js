import React, { useState } from "react";
import ChatWindow from "./ChatWindow";
import "./index.css";

function App() {
  const [projectName, setProjectName] = useState("");
  const [userInput, setUserInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [fileTree, setFileTree] = useState(null);

  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [personalAccessToken, setPersonalAccessToken] = useState("");

  const handleSend = async () => {
    const trimmedInput = userInput.trim();
    if (!trimmedInput) return;

    const newUserMessage = { role: "user", content: trimmedInput };
    setMessages((prev) => [...prev, newUserMessage]);
    setUserInput("");

    const response = await parseUserInput(trimmedInput, fileTree);
    if (response.type === "treeUpdate") {
      const updatedTree = response.data;
      setFileTree(updatedTree);

      // Mettre à jour le repo GitHub (création/MAJ des fichiers)
      if (repoOwner && repoName && personalAccessToken) {
        await uploadFileTreeToGitHub(
          updatedTree,
          repoOwner,
          repoName,
          personalAccessToken
        );
      }

      // Envoyer l’arborescence finale nettoyée (sans code, uniquement résumés)
      const treeWithSummaries = getTreeWithSummariesOnly(updatedTree);
      const newSystemMessage = {
        role: "system",
        content: JSON.stringify(treeWithSummaries, null, 2),
      };
      setMessages((prev) => [...prev, newSystemMessage]);
    } else if (response.type === "error") {
      const newSystemMessage = {
        role: "system",
        content: `Erreur: ${response.message}`,
      };
      setMessages((prev) => [...prev, newSystemMessage]);
    }
  };

  async function parseUserInput(input, currentTree) {
    const maybeJson = tryParseJson(input);
    if (maybeJson) {
      return { type: "treeUpdate", data: convertToStandardTree(maybeJson) };
    }

    const { filename, code, resumer } = parseCodeAndResumer(input);
    if (filename && code && resumer) {
      // Si on n’a pas d’arborescence locale
      if (!currentTree) {
        // On doit disposer du repoOwner, repoName et token pour aller chercher la structure sur GitHub
        if (!repoOwner || !repoName || !personalAccessToken) {
          return {
            type: "error",
            message:
              "Aucune arborescence n'est fournie et aucune info GitHub n'est disponible pour en récupérer une.",
          };
        }
        // Récupérer l’arborescence depuis GitHub
        const fetchedTree = await fetchRepoTreeFromGitHub(
          repoOwner,
          repoName,
          personalAccessToken
        );
        if (!fetchedTree) {
          return {
            type: "error",
            message: "Impossible de récupérer l'arborescence du dépôt GitHub.",
          };
        }
        currentTree = fetchedTree;
      }

      // Tentative de mise à jour locale
      let newTree = updateFileTreeWithCode(
        currentTree,
        filename,
        code,
        resumer
      );
      if (!newTree) {
        // Le fichier n'a pas été trouvé localement
        // Vérifier sur GitHub si le fichier existe
        if (!repoOwner || !repoName || !personalAccessToken) {
          return {
            type: "error",
            message:
              "Fichier non trouvé localement et pas de creds GitHub pour vérifier.",
          };
        }

        const fileExistsOnGitHub = await checkFileOnGitHub(
          repoOwner,
          repoName,
          personalAccessToken,
          filename
        );
        if (!fileExistsOnGitHub) {
          newTree = addFileToTree(currentTree, filename);
        } else {
          // Si le fichier existe sur GitHub mais n'était pas dans l'arborescence locale,
          // on l’ajoute quand même localement (le fetchRepoTreeFromGitHub aurait dû le récupérer,
          // mais s'il manque quelque chose, on le rajoute)
          newTree = addFileToTree(currentTree, filename);
        }

        newTree = updateFileTreeWithCode(newTree, filename, code, resumer);
        if (!newTree) {
          return {
            type: "error",
            message: "Impossible d'insérer le code dans le fichier.",
          };
        }
      }

      // Mettre à jour le fichier sur GitHub
      if (repoOwner && repoName && personalAccessToken) {
        const fileNode = findFileNode(newTree, filename);
        if (fileNode) {
          await createOrUpdateFileOnGitHub(
            repoOwner,
            repoName,
            personalAccessToken,
            filename,
            fileNode.content
          );
        }
      }

      return { type: "treeUpdate", data: newTree };
    }

    return {
      type: "error",
      message: "L'entrée n'est ni un JSON valide, ni un code reconnu.",
    };
  }

  function tryParseJson(str) {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  function parseCodeAndResumer(str) {
    const fichierRegex = /^Fichier:\s*(.+)$/im;
    const resumerRegex = /^Resumer:\s*(.+)$/im;

    const fichierMatch = str.match(fichierRegex);
    const resumerMatch = str.match(resumerRegex);

    if (!fichierMatch || !resumerMatch) {
      return { filename: null, code: null, resumer: null };
    }

    const filename = fichierMatch[1].trim();
    const parts = str.split(resumerRegex);
    const codePart = parts[0];

    const codeLines = codePart.split("\n");
    let codeStartIndex = 0;
    for (let i = 0; i < codeLines.length; i++) {
      if (codeLines[i].toLowerCase().includes("fichier:")) {
        codeStartIndex = i + 1;
        break;
      }
    }
    const code = codeLines.slice(codeStartIndex).join("\n").trim();

    const resumer = resumerMatch[1].trim();

    return { filename, code, resumer };
  }

  function convertToStandardTree(jsonObj, name = "root") {
    if (jsonObj && typeof jsonObj === "object" && !Array.isArray(jsonObj)) {
      let children = [];
      for (let key in jsonObj) {
        if (jsonObj[key] === null) {
          // Fichier
          children.push({
            name: key,
            type: "file",
            content: "",
          });
        } else {
          // Dossier
          children.push(convertToStandardTree(jsonObj[key], key));
        }
      }
      return { name, type: "directory", children };
    }
    return { name, type: "directory", children: [] };
  }

  async function fetchRepoTreeFromGitHub(owner, repo, token, branch = "main") {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!resp.ok) {
      console.error(
        "Erreur récupération arborescence GitHub:",
        await resp.text()
      );
      return null;
    }

    const data = await resp.json();
    if (!data.tree) return null;

    // data.tree est un tableau d'objets {path:..., type: 'tree' ou 'blob', ...}
    // On va construire un arbre {name, type, children} ou {name, type: 'file', content: ''}

    const root = { name: "root", type: "directory", children: [] };

    for (let item of data.tree) {
      const parts = item.path.split("/");
      insertPath(root, parts, item.type);
    }

    return root;
  }

  function insertPath(node, parts, itemType) {
    if (parts.length === 0) return;
    const [head, ...rest] = parts;

    let child = node.children.find((c) => c.name === head);
    if (!child) {
      if (rest.length === 0) {
        // Dernier élément : c’est un fichier si itemType = 'blob', un dossier si 'tree'
        if (itemType === "blob") {
          child = { name: head, type: "file", content: "" };
        } else {
          child = { name: head, type: "directory", children: [] };
        }
        node.children.push(child);
      } else {
        // Pas le dernier élément : forcément un dossier
        child = { name: head, type: "directory", children: [] };
        node.children.push(child);
      }
    }

    if (child.type === "directory" && rest.length > 0) {
      insertPath(child, rest, itemType);
    }
  }

  function updateFileTreeWithCode(tree, filename, code, resumer) {
    const newTree = structuredClone(tree);
    const pathParts = filename.split("/").filter((p) => p !== "");

    function findAndUpdateFile(node, parts) {
      if (node.type === "directory") {
        const [head, ...rest] = parts;
        const child = node.children.find((c) => c.name === head);
        if (child) return findAndUpdateFile(child, rest);
        return false;
      } else if (node.type === "file") {
        if (parts.length === 0) {
          node.content = code;
          node.resumer = resumer;
          return true;
        }
        return false;
      }
      return false;
    }

    const updated = findAndUpdateFile(newTree, pathParts);
    return updated ? newTree : null;
  }

  function addFileToTree(tree, filename) {
    const newTree = structuredClone(tree);
    const pathParts = filename.split("/").filter((p) => p !== "");

    function ensurePath(node, parts) {
      if (parts.length === 0) return node;
      const [head, ...rest] = parts;
      let child = node.children.find((c) => c.name === head);
      if (!child) {
        if (rest.length === 0) {
          // Fichier
          child = { name: head, type: "file", content: "" };
          node.children.push(child);
        } else {
          // Dossier
          child = { name: head, type: "directory", children: [] };
          node.children.push(child);
        }
      }
      if (child.type === "directory") {
        return ensurePath(child, rest);
      }
      return child;
    }

    ensurePath(newTree, pathParts);
    return newTree;
  }

  function findFileNode(tree, filename) {
    const pathParts = filename.split("/").filter((p) => p !== "");
    function traverse(node, parts) {
      if (parts.length === 0) return node.type === "file" ? node : null;
      if (node.type !== "directory") return null;
      const [head, ...rest] = parts;
      const child = node.children.find((c) => c.name === head);
      if (!child) return null;
      return traverse(child, rest);
    }
    return traverse(tree, pathParts);
  }

  async function checkFileOnGitHub(owner, repo, token, filename) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
      filename
    )}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (resp.status === 200) {
      return true;
    } else if (resp.status === 404) {
      return false;
    } else {
      console.error("Erreur GitHub:", await resp.text());
      return false;
    }
  }

  async function uploadFileTreeToGitHub(tree, owner, repo, token) {
    async function traverse(node, currentPath) {
      if (node.type === "directory") {
        for (let child of node.children) {
          await traverse(
            child,
            currentPath ? `${currentPath}/${child.name}` : child.name
          );
        }
      } else if (node.type === "file") {
        await createOrUpdateFileOnGitHub(
          owner,
          repo,
          token,
          currentPath,
          node.content || ""
        );
      }
    }
    await traverse(tree, "");
  }

  async function createOrUpdateFileOnGitHub(owner, repo, token, path, content) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
      path
    )}`;
    const message = `Update file ${path}`;
    const encodedContent = btoa(content);

    let sha = null;
    // Vérifier si le fichier existe déjà
    let getResp = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (getResp.ok) {
      const data = await getResp.json();
      sha = data.sha;
    }

    const putResp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        message,
        content: encodedContent,
        sha: sha || undefined,
      }),
    });

    if (!putResp.ok) {
      const errorData = await putResp.json();
      console.error("Erreur mise à jour GitHub:", errorData);
      throw new Error(`Impossible de mettre à jour le fichier ${path}`);
    }
  }

  function getTreeWithSummariesOnly(tree) {
    function transform(node) {
      if (node.type === "directory") {
        return {
          name: node.name,
          type: node.type,
          children: node.children.map(transform),
        };
      } else if (node.type === "file") {
        let newNode = {
          name: node.name,
          type: node.type,
        };
        if (node.resumer) {
          newNode.resumer = node.resumer;
        }
        return newNode;
      }
      return node;
    }

    return transform(tree);
  }

  return (
    <div className="app-container">
      <div className="top-bar">
        <label>
          Nom du projet:
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="input-text"
          />
        </label>
        <label>
          GitHub Owner:
          <input
            type="text"
            value={repoOwner}
            onChange={(e) => setRepoOwner(e.target.value)}
            className="input-text"
          />
        </label>
        <label>
          GitHub Repo:
          <input
            type="text"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            className="input-text"
          />
        </label>
        <label>
          GitHub Token:
          <input
            type="text"
            value={personalAccessToken}
            onChange={(e) => setPersonalAccessToken(e.target.value)}
            className="input-text"
          />
        </label>
      </div>
      <div className="chat-window-container">
        <ChatWindow messages={messages} />
      </div>
      <div className="input-area">
        <textarea
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          placeholder="Entrez votre instruction ou code ici..."
          className="input-textarea"
          rows={4}
        />
        <button onClick={handleSend} className="send-button">
          Envoyer
        </button>
      </div>
    </div>
  );
}

export default App;
