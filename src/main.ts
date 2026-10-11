import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

// The command registry self-registers on import; importing it here ensures
// menus/shortcuts exist before the first render.
import './commands';

createApp(App).mount('#app');
