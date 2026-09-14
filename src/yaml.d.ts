/** YAML импортируется как данные (vite: @rollup/plugin-yaml); форму проверяет загрузчик. */
declare module '*.yaml' {
  const data: unknown
  export default data
}
