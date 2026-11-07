// Placeholder route for the centre Pay tab; the tab's button opens the payment sheet instead of navigating here.
import { Redirect } from 'expo-router';

export default function PayTab() { return <Redirect href="/(app)/tenant" />; }
