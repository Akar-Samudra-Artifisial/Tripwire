import { mount } from './mount';
import { Placeholder, Shell } from './components';

mount(
  <Shell title="Tripwire setup">
    <Placeholder description="Choose the Confluence spaces to watch, the decision label and the Jira project for revisit tasks." />
  </Shell>,
);
