const slugify = (text) =>
  text
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-");

const removeFileExt = (fileName) => {
  const splitted = fileName.split(".");

  return splitted.slice(0, splitted.length - 1).join(".");
};

module.exports = { slugify, removeFileExt };
